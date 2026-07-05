/**
 * End-to-end SCD2 merge test against a throwaway lake using synthetic
 * snapshots — no network. Verifies: new/changed/retired/unchanged detection,
 * multi-part geometry union, point-in-time ("owner as of") queries, and
 * idempotent re-merge.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSchema, openLake, rowObjects, scalar } from "../src/lake.js";
import { mergeSnapshot, stageSnapshot } from "../src/pipeline.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moa-lake-test-"));
const lakeDir = path.join(tmpRoot, "lake");
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

const lake = await openLake(lakeDir);
try {
  await ensureSchema(lake.conn);

  // T1: three parcels, P2 is a two-part parcel.
  const t1 = writeSnapshot("t1", [
    { id: "P1", owner: "ALICE", value: 100_000 },
    { id: "P2", owner: "BOB", value: 200_000, parts: 2, lon: -149.8 },
    { id: "P3", owner: "CARO", value: 300_000, lon: -149.7 },
  ]);
  await stageSnapshot(lake.conn, t1);
  const m1 = await mergeSnapshot(lake.conn, "2024-07-01T00:00:00.000Z");
  assert.deepEqual(
    [m1.distinctParcels, m1.newParcels, m1.changedParcels, m1.retiredParcels, m1.unchangedParcels],
    [3, 3, 0, 0, 0],
    "T1: everything is new",
  );

  const p2 = await rowObjects(
    lake.conn,
    `SELECT feature_count, round(area_m2) AS area_m2 FROM lake.parcels_current WHERE parcel_id = 'P2'`,
  );
  assert.equal(p2.length, 1, "multi-part parcel collapses to one row");
  assert.equal(Number(p2[0]!.feature_count), 2, "P2 merged from 2 source features");
  assert.ok(Number(p2[0]!.area_m2) > 1000, "unioned area is the sum of both squares");

  // T2 (two years later): P1 sold to DAVE, P2 unchanged, P3 retired, P4 new.
  const t2 = writeSnapshot("t2", [
    { id: "P1", owner: "DAVE", value: 150_000 },
    { id: "P2", owner: "BOB", value: 200_000, parts: 2, lon: -149.8 },
    { id: "P4", owner: "ERIN", value: 400_000, lon: -149.6 },
  ]);
  await stageSnapshot(lake.conn, t2);
  const m2 = await mergeSnapshot(lake.conn, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(
    [m2.newParcels, m2.changedParcels, m2.retiredParcels, m2.unchangedParcels],
    [1, 1, 1, 1],
    "T2: P4 new, P1 changed, P3 retired, P2 unchanged",
  );

  assert.equal(Number(await scalar(lake.conn, `SELECT count(*) FROM lake.parcels`)), 5, "3 + 2 version rows");
  assert.equal(Number(await scalar(lake.conn, `SELECT count(*) FROM lake.parcels_current`)), 3);

  // Point-in-time: who owned P1 two years ago vs now?
  const asOf = (ts: string, id: string) =>
    scalar<string>(
      lake.conn,
      `SELECT owner_name FROM lake.parcels
       WHERE parcel_id = '${id}' AND valid_from <= TIMESTAMP '${ts}'
         AND (valid_to IS NULL OR valid_to > TIMESTAMP '${ts}')`,
    );
  assert.equal(await asOf("2025-01-01", "P1"), "ALICE", "P1 owned by ALICE in 2025");
  assert.equal(await asOf("2026-07-02", "P1"), "DAVE", "P1 owned by DAVE after the sale");
  assert.equal(await asOf("2025-01-01", "P3"), "CARO", "P3 existed in 2025");
  assert.equal(await asOf("2026-07-02", "P3"), undefined, "P3 retired by 2026");

  // Idempotence: merging the same snapshot again changes nothing.
  await stageSnapshot(lake.conn, t2);
  const m3 = await mergeSnapshot(lake.conn, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(
    [m3.newParcels, m3.changedParcels, m3.retiredParcels, m3.unchangedParcels],
    [0, 0, 0, 3],
    "re-merge is a no-op",
  );
  assert.equal(Number(await scalar(lake.conn, `SELECT count(*) FROM lake.parcels`)), 5, "still 5 rows");

  console.log("merge.test.ts: all assertions passed");
} finally {
  await lake.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
