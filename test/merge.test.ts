/**
 * End-to-end SCD2 merge test against a throwaway database using synthetic
 * snapshots — no network. Verifies: new/changed/retired/unchanged detection,
 * multi-part geometry union, point-in-time ("owner as of") queries, and
 * idempotent re-merge.
 *
 * The tests in this file are sequential and share the database: each stage
 * builds on the merges performed by the ones before it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureSchema, openStore, rowObjects, scalar } from "../src/store.js";
import { mergeSnapshot, stageSnapshot } from "../src/pipeline.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moa-lake-test-"));
const rawDir = path.join(tmpRoot, "raw");
fs.mkdirSync(rawDir, { recursive: true });

function square(lon: number, lat: number, d = 0.001): string {
  const ring = [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ];
  return JSON.stringify({ type: "Polygon", coordinates: [ring] });
}

interface FakeParcel {
  id: string;
  owner: string | null;
  value: number | null;
  parts?: number;
  lon?: number;
}

function featureLines(parcels: FakeParcel[]): string {
  const lines: string[] = [];
  for (const p of parcels) {
    const parts = p.parts ?? 1;
    for (let i = 1; i <= parts; i++) {
      lines.push(
        JSON.stringify({
          Parcel_ID: p.id,
          Parcel_ID_Count: i,
          Owner_Name: p.owner,
          Appraised_Total_Value: p.value,
          Appraisal_Year: 2026,
          PUBDATE: Date.UTC(2026, 6, 1),
          __geometry: square((p.lon ?? -149.9) + (i - 1) * 0.002, 61.2),
        }),
      );
    }
  }
  return lines.join("\n") + "\n";
}

function writeSnapshot(name: string, parcels: FakeParcel[]): string {
  const dir = path.join(rawDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "page-00000.ndjson"), featureLines(parcels));
  return path.join(dir, "*.ndjson");
}

let lake: Awaited<ReturnType<typeof openStore>>;

// T2 snapshot path is written in T1's test and re-used by the idempotence test.
let t2: string;

beforeAll(async () => {
  lake = await openStore({ dbPath: path.join(tmpRoot, "anchorage.duckdb"), createIfMissing: true });
  await ensureSchema(lake.conn);
});

afterAll(async () => {
  await lake?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

it("T1: first merge treats every parcel as new", async () => {
  // Three parcels, P2 is a two-part parcel.
  const t1 = writeSnapshot("t1", [
    { id: "P1", owner: "ALICE", value: 100_000 },
    { id: "P2", owner: "BOB", value: 200_000, parts: 2, lon: -149.8 },
    { id: "P3", owner: "CARO", value: 300_000, lon: -149.7 },
  ]);
  await stageSnapshot(lake.conn, t1);
  const m1 = await mergeSnapshot(lake.conn, "2024-07-01T00:00:00.000Z");
  expect([
    m1.distinctParcels,
    m1.newParcels,
    m1.changedParcels,
    m1.retiredParcels,
    m1.unchangedParcels,
  ]).toEqual([3, 3, 0, 0, 0]);
});

it("multi-part parcel collapses to one row with unioned geometry", async () => {
  const p2 = await rowObjects(
    lake.conn,
    `SELECT feature_count, round(area_m2) AS area_m2 FROM parcels_current WHERE parcel_id = 'P2'`,
  );
  expect(p2).toHaveLength(1);
  expect(Number(p2[0]!.feature_count)).toBe(2);
  // Unioned area is the sum of both squares.
  expect(Number(p2[0]!.area_m2)).toBeGreaterThan(1000);
});

it("T2: detects new, changed, retired, and unchanged parcels", async () => {
  // Two years later: P1 sold to DAVE, P2 unchanged, P3 retired, P4 new.
  t2 = writeSnapshot("t2", [
    { id: "P1", owner: "DAVE", value: 150_000 },
    { id: "P2", owner: "BOB", value: 200_000, parts: 2, lon: -149.8 },
    { id: "P4", owner: "ERIN", value: 400_000, lon: -149.6 },
  ]);
  await stageSnapshot(lake.conn, t2);
  const m2 = await mergeSnapshot(lake.conn, "2026-07-01T00:00:00.000Z");
  expect([m2.newParcels, m2.changedParcels, m2.retiredParcels, m2.unchangedParcels]).toEqual([
    1, 1, 1, 1,
  ]);

  // 3 + 2 version rows, 3 current.
  expect(Number(await scalar(lake.conn, `SELECT count(*) FROM parcels`))).toBe(5);
  expect(Number(await scalar(lake.conn, `SELECT count(*) FROM parcels_current`))).toBe(3);
});

it("point-in-time queries see historical owners", async () => {
  const asOf = (ts: string, id: string) =>
    scalar<string>(
      lake.conn,
      `SELECT owner_name FROM parcels
       WHERE parcel_id = '${id}' AND valid_from <= TIMESTAMP '${ts}'
         AND (valid_to IS NULL OR valid_to > TIMESTAMP '${ts}')`,
    );
  expect(await asOf("2025-01-01", "P1")).toBe("ALICE");
  expect(await asOf("2026-07-02", "P1")).toBe("DAVE");
  expect(await asOf("2025-01-01", "P3")).toBe("CARO");
  expect(await asOf("2026-07-02", "P3")).toBeUndefined();
});

it("re-merging the same snapshot is a no-op", async () => {
  await stageSnapshot(lake.conn, t2);
  const m3 = await mergeSnapshot(lake.conn, "2026-07-02T00:00:00.000Z");
  expect([m3.newParcels, m3.changedParcels, m3.retiredParcels, m3.unchangedParcels]).toEqual([
    0, 0, 0, 3,
  ]);
  expect(Number(await scalar(lake.conn, `SELECT count(*) FROM parcels`))).toBe(5);
});
