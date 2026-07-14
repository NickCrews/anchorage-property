/**
 * Staging-time cleaning: impossible YearBuilt values observed in the source
 * (literal 1, 1190, future years like 2036) must be staged as NULL, and every
 * year that survives staging must sit inside the plausible window — no
 * network, synthetic NDJSON through the real stageSnapshot SQL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureSchema, openStore, rowObjects, scalar } from "../src/store.js";
import { stageSnapshot } from "../src/pipeline.js";
import { YEAR_BUILT_FLOOR } from "../src/fields.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moa-clean-test-"));
const ceiling = new Date().getFullYear() + 1;

function square(lon: number): string {
  const ring = [
    [lon, 61.2],
    [lon + 0.001, 61.2],
    [lon + 0.001, 61.201],
    [lon, 61.201],
    [lon, 61.2],
  ];
  return JSON.stringify({ type: "Polygon", coordinates: [ring] });
}

function featureLine(id: string, year: number | null, lon: number): string {
  return JSON.stringify({
    Parcel_ID: id,
    Parcel_ID_Count: 1,
    Owner_Name: "OWNER",
    YearBuilt: year === null ? null : String(year),
    YearBuilt_Min: year,
    YearBuilt_Max: year,
    __geometry: square(lon),
  });
}

let lake: Awaited<ReturnType<typeof openStore>>;

beforeAll(async () => {
  lake = await openStore({ dbPath: path.join(tmpRoot, "anchorage.duckdb"), createIfMissing: true });
  await ensureSchema(lake.conn);

  const cases: Array<[string, number | null]> = [
    ["SENTINEL_ONE", 1],
    ["MEDIEVAL", 1190],
    ["FAR_FUTURE", ceiling + 10],
    ["JUST_TOO_LATE", ceiling + 1],
    ["FLOOR", YEAR_BUILT_FLOOR],
    ["GOLD_RUSH", 1898],
    ["ORDINARY", 1975],
    ["NEXT_YEAR", ceiling],
    ["UNBUILT", null],
  ];
  const lines = cases.map(([id, year], i) => featureLine(id, year, -149.9 + i * 0.002));
  const dir = path.join(tmpRoot, "raw");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "page-00000.ndjson"), lines.join("\n") + "\n");
  await stageSnapshot(lake.conn, path.join(dir, "*.ndjson"));
});

afterAll(async () => {
  await lake?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

it("nullifies impossible years and keeps plausible ones, across all three columns", async () => {
  const rows = await rowObjects(
    lake.conn,
    `SELECT parcel_id, year_built, year_built_min, year_built_max FROM snapshot ORDER BY parcel_id`,
  );
  const byId = Object.fromEntries(rows.map((r) => [r.parcel_id as string, r]));

  for (const id of ["SENTINEL_ONE", "MEDIEVAL", "FAR_FUTURE", "JUST_TOO_LATE", "UNBUILT"]) {
    expect(byId[id], id).toMatchObject({ year_built: null, year_built_min: null, year_built_max: null });
  }
  expect(byId.FLOOR).toMatchObject({
    year_built: String(YEAR_BUILT_FLOOR),
    year_built_min: YEAR_BUILT_FLOOR,
    year_built_max: YEAR_BUILT_FLOOR,
  });
  expect(byId.GOLD_RUSH).toMatchObject({ year_built: "1898", year_built_min: 1898, year_built_max: 1898 });
  expect(byId.ORDINARY).toMatchObject({ year_built: "1975", year_built_min: 1975, year_built_max: 1975 });
  expect(byId.NEXT_YEAR).toMatchObject({ year_built: String(ceiling), year_built_min: ceiling, year_built_max: ceiling });
});

it("cleaned output carries no year outside the plausible window", async () => {
  const outside = Number(
    await scalar(
      lake.conn,
      `SELECT count(*) FROM snapshot
       WHERE year_built_min NOT BETWEEN ${YEAR_BUILT_FLOOR} AND ${ceiling}
          OR year_built_max NOT BETWEEN ${YEAR_BUILT_FLOOR} AND ${ceiling}
          OR TRY_CAST(year_built AS INTEGER) NOT BETWEEN ${YEAR_BUILT_FLOOR} AND ${ceiling}
          OR (year_built IS NOT NULL AND TRY_CAST(year_built AS INTEGER) IS NULL)`,
    ),
  );
  expect(outside).toBe(0);
});
