/**
 * General invariants of the published lake that downstream analysis
 * (e.g. the notebooks' "Value basis" selector) relies on. Runs against
 * the published lake over HTTPS (override with LAKE_ATTACH), so it
 * needs network.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, it } from "vitest";

const attach =
  process.env.LAKE_ATTACH ??
  "ducklake:https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/catalog.ducklake";

let instance: DuckDBInstance;
let conn: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  await conn.run("INSTALL ducklake;");
  await conn.run(`ATTACH '${attach}' AS lake (READ_ONLY)`);
});

afterAll(() => {
  conn?.closeSync();
  instance?.closeSync();
});

async function one(sql: string): Promise<Record<string, unknown>> {
  const r = await (await conn.run(sql)).getRowObjectsJson();
  expect(r, `expected exactly one row from: ${sql}`).toHaveLength(1);
  return r[0]!;
}

// ---------------------------------------------------------------------------
// The assessor's total is the sum of its parts: for every parcel,
// appraised_total_value = appraised_land_value + appraised_building_value.
// The equality was exact (0 mismatches over 98,519 parcels) on 2026-07-05;
// a sub-cent tolerance guards against future rounding in the DOUBLE columns.
it("appraised total = land + structures for every parcel", async () => {
  const r = await one(
    `SELECT count(*) AS n,
            count(*) FILTER (
              abs(coalesce(appraised_total_value, 0)
                  - (coalesce(appraised_land_value, 0)
                     + coalesce(appraised_building_value, 0))) > 0.005
            ) AS mismatches
     FROM lake.parcels_current`,
  );
  const n = Number(r.n);
  const mismatches = Number(r.mismatches);
  expect(n, `parcels_current has only ${n} rows`).toBeGreaterThanOrEqual(50_000);
  expect(
    mismatches,
    `${mismatches} of ${n} parcels violate total = land + structures`,
  ).toBe(0);
});
