/**
 * Executable proof of the README's Girdwood classification:
 *
 *   tax_district = '4'   -- the Girdwood Valley Service Area
 *
 * Each test pins down one claim made alongside that example query. Runs
 * against the published archive over HTTPS (override with DB_ATTACH), so it
 * needs network. The data drifts daily, so counts are asserted as tolerant
 * invariants; the exact figures on 2026-07-05 are noted in comments.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PUBLIC_ARCHIVE_URL } from "../src/config.js";

const attach = process.env.DB_ATTACH ?? PUBLIC_ARCHIVE_URL;

const GIRDWOOD = `tax_district = '4'`;

let instance: DuckDBInstance;
let conn: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  await conn.run("INSTALL spatial; LOAD spatial;");
  await conn.run(`ATTACH '${attach}' AS lake (READ_ONLY)`);
});

afterAll(() => {
  conn?.closeSync();
  instance?.closeSync();
});

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.run(sql)).getRowObjectsJson();
}
async function one(sql: string): Promise<Record<string, unknown>> {
  const r = await rows(sql);
  expect(r, `expected exactly one row from: ${sql}`).toHaveLength(1);
  return r[0]!;
}

// ---------------------------------------------------------------------------
// Claim 1: tax district '4' exists, is spelled exactly '4' (not '04'), and is
// Girdwood-sized. (1,851 parcels on 2026-07-05.)
it("district 4 exists and is Girdwood-sized", async () => {
  const r = await one(
    `SELECT count(*) AS n FROM lake.parcels_current WHERE ${GIRDWOOD}`,
  );
  const n = Number(r.n);
  expect(n, `district 4 has ${n} parcels, expected ~1,851`).toBeGreaterThanOrEqual(1_000);
  expect(n).toBeLessThanOrEqual(3_000);
});

// ---------------------------------------------------------------------------
// Claim 2: the boundary doesn't leak. Every parcel inside district 4 has a
// Girdwood site address or no site address at all — never Anchorage, Eagle
// River, Chugiak, or Indian.
it("district 4 contains only Girdwood (or blank) site addresses", async () => {
  const r = await rows(
    `SELECT DISTINCT gis_site_city FROM lake.parcels_current WHERE ${GIRDWOOD}`,
  );
  const cities = r.map((x) => x.gis_site_city);
  expect(
    cities.filter((c) => c !== null && c !== "Girdwood"),
    `district 4 contains foreign city labels: ${JSON.stringify(cities)}`,
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// Claim 3: the two definitions agree on the core. At least 95% of parcels
// with a Girdwood site address are in district 4, and the stragglers sit
// only in district '15' (the Turnagain Arm fringe) or have a blank district —
// never in another numbered district. (51 + 3 of 1,615 on 2026-07-05.)
it("nearly all Girdwood-addressed parcels are in district 4", async () => {
  const r = await one(
    `SELECT count(*) AS n, count(*) FILTER (${GIRDWOOD}) AS in_d4
     FROM lake.parcels_current WHERE gis_site_city = 'Girdwood'`,
  );
  const share = Number(r.in_d4) / Number(r.n);
  expect(
    share,
    `only ${(share * 100).toFixed(1)}% of Girdwood-addressed parcels are in district 4`,
  ).toBeGreaterThanOrEqual(0.95);

  const stragglers = await rows(
    `SELECT DISTINCT tax_district FROM lake.parcels_current
     WHERE gis_site_city = 'Girdwood' AND NOT (${GIRDWOOD})`,
  );
  const districts = stragglers.map((x) => x.tax_district);
  expect(
    districts.filter((d) => d !== "15" && d !== "" && d !== null),
    `Girdwood-addressed parcels found in unexpected districts: ${JSON.stringify(districts)}`,
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// Claim 4: the tax-district test catches what the address test misses —
// district 4 holds a few hundred parcels with no site address, and they are
// mostly vacant land. (290 parcels, 91% with a vacant/no-building record,
// on 2026-07-05.)
it("district 4 includes address-less, mostly vacant parcels", async () => {
  const r = await one(
    `SELECT count(*) AS n,
            count(*) FILTER (coalesce(appraised_building_value, 0) = 0) AS no_building
     FROM lake.parcels_current WHERE ${GIRDWOOD} AND gis_site_city IS NULL`,
  );
  const n = Number(r.n);
  const vacantShare = Number(r.no_building) / n;
  expect(n, `expected a few hundred address-less district-4 parcels, got ${n}`).toBeGreaterThanOrEqual(100);
  expect(
    vacantShare,
    `only ${(vacantShare * 100).toFixed(0)}% of them are building-less`,
  ).toBeGreaterThanOrEqual(0.8);
});

// ---------------------------------------------------------------------------
// Claim 5: district 4 is geographically Girdwood. Every parcel's geometry
// falls inside a generous Girdwood-valley bounding box (the actual extent on
// 2026-07-05 was lon -149.182..-149.053, lat 60.911..61.000), nowhere near
// the Anchorage Bowl (~ -149.9, 61.2).
it("district 4 geometry stays inside the Girdwood valley", async () => {
  const r = await one(
    `SELECT min(ST_XMin(g)) AS min_lon, max(ST_XMax(g)) AS max_lon,
            min(ST_YMin(g)) AS min_lat, max(ST_YMax(g)) AS max_lat
     FROM (SELECT ST_GeomFromWKB(geom_wkb) AS g
           FROM lake.parcels_current WHERE ${GIRDWOOD})`,
  );
  const minLon = Number(r.min_lon);
  const maxLon = Number(r.max_lon);
  const minLat = Number(r.min_lat);
  const maxLat = Number(r.max_lat);
  expect(minLon, `district 4 lon extent [${minLon}, ${maxLon}] outside Girdwood valley`).toBeGreaterThanOrEqual(-149.3);
  expect(maxLon).toBeLessThanOrEqual(-148.9);
  expect(minLat, `district 4 lat extent [${minLat}, ${maxLat}] outside Girdwood valley`).toBeGreaterThanOrEqual(60.85);
  expect(maxLat).toBeLessThanOrEqual(61.05);
});

// ---------------------------------------------------------------------------
// Claim 6: the legal-description alternative is much worse — matching
// '%GIRDWOOD%' finds well under a quarter of the service area's parcels.
// (242 of 1,851 on 2026-07-05.)
it("legal-description matching misses most of the service area", async () => {
  const r = await one(
    `SELECT count(*) FILTER (upper(legal_description) LIKE '%GIRDWOOD%') AS legal_n,
            count(*) FILTER (${GIRDWOOD}) AS d4_n
     FROM lake.parcels_current`,
  );
  const legalN = Number(r.legal_n);
  const d4N = Number(r.d4_n);
  expect(
    legalN,
    `legal-description match found ${legalN} of ${d4N} district-4 parcels`,
  ).toBeLessThan(d4N * 0.25);
});
