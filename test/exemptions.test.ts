/**
 * Executable proof of the exemption catalog in src/exemptions.ts: every
 * exemption value in the published archive is a known one, and the structural
 * relationships documented there hold. The upstream layer has no coded-value
 * domain for these columns, so these tests are the tripwire that catches the
 * muni introducing a new exemption type (or restructuring the columns).
 * Runs against the published archive over HTTPS (override with DB_ATTACH),
 * so it needs network.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  EXEMPTION_TYPE_GROUPS,
  INSTITUTIONAL_EXEMPTION_BASES,
  PERSONAL_EXEMPTION_TYPES,
  RESIDENTIAL_EXEMPTION_TYPES,
  institutionalBase,
} from "../src/exemptions.js";
import { PUBLIC_ARCHIVE_URL } from "../src/config.js";

const attach = process.env.DB_ATTACH ?? PUBLIC_ARCHIVE_URL;

let instance: DuckDBInstance;
let conn: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
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
async function distinctValues(column: string): Promise<string[]> {
  const r = await rows(
    `SELECT DISTINCT ${column} AS v FROM lake.parcels_current WHERE ${column} IS NOT NULL`,
  );
  return r.map((x) => x.v as string);
}

// ---------------------------------------------------------------------------
// Slots 1–2 hold institutional exemptions: every value, after stripping the
// " - LAND" suffix, is a known institutional base. A new base name here means
// the muni added an exemption category — add it to INSTITUTIONAL_EXEMPTION_BASES
// after eyeballing it (watch for more upstream typos like NAVITE).
for (const slot of [1, 2]) {
  it(`exemption_${slot}_type values are known institutional types`, async () => {
    const values = await distinctValues(`exemption_${slot}_type`);
    const known = new Set<string>(INSTITUTIONAL_EXEMPTION_BASES);
    const unknown = values.filter((v) => !known.has(institutionalBase(v)));
    expect(
      unknown,
      `new institutional exemption type(s) in slot ${slot}: ${JSON.stringify(unknown)}`,
    ).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Slot 5 holds the personal state-mandated exemptions (senior / disabled vet /
// military widow(er)) and nothing else.
it("exemption_5_type values are known personal types", async () => {
  const values = await distinctValues("exemption_5_type");
  const known = new Set<string>(PERSONAL_EXEMPTION_TYPES);
  const unknown = values.filter((v) => !known.has(v));
  expect(unknown, `new personal exemption type(s): ${JSON.stringify(unknown)}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// Slot 6 holds only the residential exemption.
it("exemption_6_type values are known residential types", async () => {
  const values = await distinctValues("exemption_6_type");
  const known = new Set<string>(RESIDENTIAL_EXEMPTION_TYPES);
  const unknown = values.filter((v) => !known.has(v));
  expect(unknown, `new residential exemption type(s): ${JSON.stringify(unknown)}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// exemption_type_group is exactly the two-value flag documented in
// src/exemptions.ts: 'No Exemptions' when all four slots are empty, 'Other'
// otherwise. If the muni ever splits 'Other' into real groups, this fails and
// the catalog (plus any queries keying on the flag) needs a fresh look.
it("exemption_type_group is the documented two-value flag", async () => {
  const values = await distinctValues("exemption_type_group");
  expect(values.sort()).toEqual([...EXEMPTION_TYPE_GROUPS]);

  const r = await one(
    `SELECT count(*) FILTER (
       (exemption_type_group = 'No Exemptions') <>
       (exemption_1_type IS NULL AND exemption_2_type IS NULL
        AND exemption_5_type IS NULL AND exemption_6_type IS NULL)
     ) AS mismatches
     FROM lake.parcels_current`,
  );
  const mismatches = Number(r.mismatches);
  expect(
    mismatches,
    `${mismatches} parcels where the group flag disagrees with the slots`,
  ).toBe(0);
});

// ---------------------------------------------------------------------------
// A slot's type and amount travel together: the type is non-null exactly when
// the amount is nonzero. (Exact over all 98,519 parcels on 2026-07-05.)
it("each slot's type is present iff its amount is nonzero", async () => {
  for (const slot of [1, 2, 5, 6]) {
    const r = await one(
      `SELECT count(*) FILTER (
         (exemption_${slot}_type IS NOT NULL) <> (coalesce(exemption_${slot}_amount, 0) <> 0)
       ) AS mismatches
       FROM lake.parcels_current`,
    );
    const mismatches = Number(r.mismatches);
    expect(mismatches, `slot ${slot}: ${mismatches} type/amount mismatches`).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// total_exemptions is the sum of its four parts. (Exact, 0 mismatches over
// 98,519 parcels on 2026-07-05; sub-cent tolerance for DOUBLE rounding.)
it("total_exemptions = sum of the four slot amounts", async () => {
  const r = await one(
    `SELECT count(*) AS n,
            count(*) FILTER (
              abs(coalesce(total_exemptions, 0)
                  - (coalesce(exemption_1_amount, 0) + coalesce(exemption_2_amount, 0)
                     + coalesce(exemption_5_amount, 0) + coalesce(exemption_6_amount, 0))) > 0.005
            ) AS mismatches
     FROM lake.parcels_current`,
  );
  const n = Number(r.n);
  const mismatches = Number(r.mismatches);
  expect(n, `parcels_current has only ${n} rows`).toBeGreaterThanOrEqual(50_000);
  expect(mismatches, `${mismatches} of ${n} parcels violate the sum`).toBe(0);
});

// ---------------------------------------------------------------------------
// Exemptions are what separates appraised from taxable: taxable_value =
// appraised_total_value − total_exemptions, exactly, on every parcel.
// Compared through coalesce because a zero difference is stored as either 0
// or NULL. (Exact over 98,519 parcels on 2026-07-05.)
it("taxable_value = appraised_total_value - total_exemptions", async () => {
  const r = await one(
    `SELECT count(*) FILTER (
       abs(coalesce(taxable_value, 0)
           - (coalesce(appraised_total_value, 0) - coalesce(total_exemptions, 0))) > 0.005
     ) AS mismatches
     FROM lake.parcels_current`,
  );
  const mismatches = Number(r.mismatches);
  expect(
    mismatches,
    `${mismatches} parcels violate taxable = appraised total - exemptions`,
  ).toBe(0);
});

// ---------------------------------------------------------------------------
// The two quirks of taxable_value the formula test coalesces over. A zero
// difference is stored two distinct ways, and the split is meaningful:
// NULL marks an *unvalued* parcel (no appraisal, no exemptions — 1,136 on
// 2026-07-05) while an explicit 0 marks a *valued but fully exempted* one
// (appraised > 0 offset by exemptions — 5,901). The populations are disjoint
// upstream (verified 2026-07-06) and the importer preserves the NULL. And
// over-exempted parcels drive it negative — legitimately, but only ever a
// handful (6 on 2026-07-05).
it("taxable_value: NULL means unvalued, 0 means fully exempted, negative only rarely", async () => {
  const r = await one(
    `SELECT count(*) FILTER (
       taxable_value IS NULL
       AND (coalesce(appraised_total_value, 0) <> 0 OR coalesce(total_exemptions, 0) <> 0)
     ) AS bad_nulls,
     count(*) FILTER (
       taxable_value = 0 AND coalesce(total_exemptions, 0) = 0
     ) AS bad_zeros,
     count(*) FILTER (taxable_value < 0) AS negatives
     FROM lake.parcels_current`,
  );
  const badNulls = Number(r.bad_nulls);
  const badZeros = Number(r.bad_zeros);
  const negatives = Number(r.negatives);
  expect(
    badNulls,
    `${badNulls} parcels have NULL taxable_value but an appraisal or exemptions (NULL should mean unvalued)`,
  ).toBe(0);
  expect(
    badZeros,
    `${badZeros} parcels have an explicit 0 taxable_value without exemptions (0 should mean fully exempted)`,
  ).toBe(0);
  expect(
    negatives,
    `${negatives} parcels have negative taxable_value, expected a handful (~6)`,
  ).toBeLessThanOrEqual(100);
});

// ---------------------------------------------------------------------------
// net_taxable_value is taxable_value floored at zero — almost. It is never
// NULL and never negative, and on ≥99.5% of parcels equals
// greatest(taxable_value, 0). The stragglers (134 on 2026-07-05, skewed
// toward high-value parcels) carry a tax-roll-side number the CAMA columns
// can't reproduce; if this share ever grows, the two columns have genuinely
// diverged and src/exemptions.ts needs a fresh look.
it("net_taxable_value ≈ greatest(taxable_value, 0), never NULL or negative", async () => {
  const r = await one(
    `SELECT count(*) AS n,
            count(*) FILTER (net_taxable_value IS NULL) AS nulls,
            count(*) FILTER (net_taxable_value < 0) AS negatives,
            count(*) FILTER (
              abs(coalesce(net_taxable_value, 0)
                  - greatest(coalesce(taxable_value, 0), 0)) > 0.005
            ) AS mismatches
     FROM lake.parcels_current`,
  );
  expect(Number(r.nulls), `${r.nulls} parcels have NULL net_taxable_value`).toBe(0);
  expect(Number(r.negatives), `${r.negatives} parcels have negative net_taxable_value`).toBe(0);
  const share = Number(r.mismatches) / Number(r.n);
  expect(
    share,
    `${r.mismatches} of ${r.n} parcels (${(share * 100).toFixed(2)}%) diverge from greatest(taxable_value, 0), expected ~0.14%`,
  ).toBeLessThanOrEqual(0.005);
});
