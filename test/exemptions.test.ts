/**
 * Tests for the owner-type categorization rules and the `exemptions` schema
 * that ensureSchema installs into the archive — no network.
 *
 * Two layers: pure invariants over the rule catalog in src/exemptions.ts, and
 * a golden fixture (one hand-written row per branch of the rule) run through
 * the persisted `exemptions.categorize_by_exemption` macro. The fixture is
 * queried twice — through the store that created the macro, and again through
 * a fresh connection with the file ATTACHed under an alias — because DuckDB
 * persists catalog entries with whatever qualification they were born with,
 * and a macro that only works under its birth alias must not ship.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CORPORATE_NAME_PATTERN,
  INSTITUTIONAL_EXEMPTION_BASES,
  OWNER_IDENTIFYING_BASES,
  OWNER_TYPES,
  USE_IDENTIFYING_BASES,
  institutionalBase,
} from "../src/exemptions.js";
import { sqlStr } from "../src/quote.js";
import { ensureSchema, openStore, rowObjects, scalar } from "../src/store.js";

// --- The rule catalog is internally consistent ------------------------------

it("institutionalBase strips the LAND suffix but not names that end in LAND", () => {
  expect(institutionalBase("RELIGIOUS ORG - LAND")).toBe("RELIGIOUS ORG");
  expect(institutionalBase("RELIGIOUS ORG")).toBe("RELIGIOUS ORG");
  // A complete type name, not a " - LAND" variant.
  expect(institutionalBase("RIGHT-OF-WAY LAND")).toBe("RIGHT-OF-WAY LAND");
});

it("owner- and use-identifying bases partition the normalized institutional catalog", () => {
  const ownerBases = Object.keys(OWNER_IDENTIFYING_BASES);
  const classified = [...ownerBases, ...USE_IDENTIFYING_BASES];
  const normalizedCatalog = new Set(
    INSTITUTIONAL_EXEMPTION_BASES.map((b) => b.replace("NAVITE", "NATIVE")),
  );
  expect(new Set(classified)).toEqual(normalizedCatalog);
  // A base classified both ways would make the rule ambiguous.
  expect(classified.length).toBe(new Set(classified).size);
});

it("every owner-identifying base maps to a known owner type", () => {
  for (const ownerType of Object.values(OWNER_IDENTIFYING_BASES)) {
    expect(OWNER_TYPES).toContain(ownerType);
  }
});

it("the corporate-name guard matches entity suffixes, not substrings", () => {
  const re = new RegExp(CORPORATE_NAME_PATTERN);
  expect("ACME RENTALS LLC").toMatch(re);
  expect("ACME RENTALS INC.").toMatch(re);
  // INC/CORP etc. must be standalone tokens: no false positive on names.
  expect("LINCOLN JAMES").not.toMatch(re);
  expect("CORPUZ MARIA").not.toMatch(re);
});

// --- The persisted macro implements the rule --------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moa-exemptions-test-"));
const dbPath = path.join(tmpRoot, "anchorage.duckdb");

// One row per branch of the rule: this pins the " - LAND" stripping, the
// NAVITE alias, the slot-2-only case, both name guards, the use-based
// refusal, and the no-exemption default.
const FIXTURE_SQL = `
  CREATE OR REPLACE TABLE fixture AS
  SELECT * FROM (VALUES
    ('land-suffix stripped',      'ANCHORAGE MUNICIPALITY OF', 'MOA OWNED (EXC. SCHOOLS) - LAND', NULL, NULL, NULL),
    ('slot 2 only, NAVITE alias', 'EKLUTNA INC',               NULL, 'NAVITE GROUPS / CORP OWNED', NULL, NULL),
    ('residential exemption',     'SMITH JOHN A',              NULL, NULL, NULL, 'OWNERS PRIMARY RESIDENCE'),
    ('trust guard',               'SMITH FAMILY TRUST',        NULL, NULL, 'SENIOR SELF: PRIMARY RESI', NULL),
    ('corporate guard',           'ACME RENTALS LLC',          NULL, NULL, NULL, 'OWNERS PRIMARY RESIDENCE'),
    ('use-based, no owner claim', 'HULTQUIST HOMES INC',       'SUBDIVISION', NULL, NULL, NULL),
    ('no exemption',              'DOE JANE',                  NULL, NULL, NULL, NULL)
  ) t(scenario, owner_name, exemption_1_type, exemption_2_type, exemption_5_type, exemption_6_type)
`;

const EXPECTED = [
  { scenario: "corporate guard", owner_type: null, basis: "person_exemption_corporate_named" },
  { scenario: "land-suffix stripped", owner_type: "government", basis: "owner_identifying_exemption" },
  { scenario: "no exemption", owner_type: null, basis: "no_exemption" },
  { scenario: "residential exemption", owner_type: "person", basis: "person_exemption" },
  { scenario: "slot 2 only, NAVITE alias", owner_type: "native_corp", basis: "owner_identifying_exemption" },
  { scenario: "trust guard", owner_type: null, basis: "person_exemption_trust_named" },
  { scenario: "use-based, no owner claim", owner_type: null, basis: "use_based_exemption_only" },
];

let lake: Awaited<ReturnType<typeof openStore>>;

beforeAll(async () => {
  lake = await openStore({ dbPath, createIfMissing: true });
  await ensureSchema(lake.conn);
  await lake.conn.run(FIXTURE_SQL);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

it("categorize_by_exemption labels every branch of the golden fixture", async () => {
  const rows = await rowObjects(
    lake.conn,
    `SELECT scenario, owner_type, basis
     FROM exemptions.categorize_by_exemption('fixture') ORDER BY scenario`,
  );
  expect(rows).toEqual(EXPECTED);
});

it("source columns pass through untouched, one output row per input row", async () => {
  const rows = await rowObjects(
    lake.conn,
    `SELECT * FROM exemptions.categorize_by_exemption('fixture')`,
  );
  expect(rows).toHaveLength(7);
  expect(Object.keys(rows[0]!)).toEqual([
    "scenario",
    "owner_name",
    "exemption_1_type",
    "exemption_2_type",
    "exemption_5_type",
    "exemption_6_type",
    "owner_type",
    "basis",
  ]);
});

it("institutional_base strips the suffix and folds the NAVITE typo", async () => {
  expect(
    await scalar(lake.conn, `SELECT exemptions.institutional_base('RELIGIOUS ORG - LAND')`),
  ).toBe("RELIGIOUS ORG");
  expect(
    await scalar(lake.conn, `SELECT exemptions.institutional_base('NAVITE GROUPS / CORP OWNED')`),
  ).toBe("NATIVE GROUPS / CORP OWNED");
});

it("the rules tables ship the full catalog", async () => {
  expect(
    Number(await scalar(lake.conn, `SELECT count(*) FROM exemptions.owner_identifying`)),
  ).toBe(Object.keys(OWNER_IDENTIFYING_BASES).length);
  expect(
    Number(await scalar(lake.conn, `SELECT count(*) FROM exemptions.use_identifying`)),
  ).toBe(USE_IDENTIFYING_BASES.length);
});

it("every shipped object carries a runtime-introspectable comment", async () => {
  const tables = await rowObjects(
    lake.conn,
    `SELECT table_name, comment FROM duckdb_tables() WHERE schema_name = 'exemptions'`,
  );
  expect(tables.map((t) => t.table_name).sort()).toEqual(["owner_identifying", "use_identifying"]);
  for (const t of tables) expect(t.comment).toBeTruthy();

  const columns = await rowObjects(
    lake.conn,
    `SELECT column_name, comment FROM duckdb_columns() WHERE schema_name = 'exemptions'`,
  );
  expect(columns.length).toBeGreaterThanOrEqual(3);
  for (const c of columns) expect(c.comment).toBeTruthy();

  const macros = await rowObjects(
    lake.conn,
    `SELECT DISTINCT function_name, comment FROM duckdb_functions() WHERE schema_name = 'exemptions'`,
  );
  expect(macros.map((m) => m.function_name).sort()).toEqual([
    "categorize_by_exemption",
    "institutional_base",
  ]);
  for (const m of macros) expect(m.comment).toBeTruthy();
});

it("the persisted macro survives reopening under a different alias", async () => {
  await lake.close();

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(`ATTACH ${sqlStr(dbPath)} AS elsewhere (READ_ONLY)`);
    const rows = await rowObjects(
      conn,
      `SELECT scenario, owner_type, basis
       FROM elsewhere.exemptions.categorize_by_exemption('elsewhere.fixture') ORDER BY scenario`,
    );
    expect(rows).toEqual(EXPECTED);
    expect(
      await scalar(conn, `SELECT elsewhere.exemptions.institutional_base('RELIGIOUS ORG - LAND')`),
    ).toBe("RELIGIOUS ORG");
    // Comments are part of the persisted catalog, so a reader of the
    // published file gets the docs too.
    expect(
      await scalar(
        conn,
        `SELECT comment FROM duckdb_tables()
         WHERE database_name = 'elsewhere' AND schema_name = 'exemptions'
           AND table_name = 'owner_identifying'`,
      ),
    ).toContain("WHO owns the parcel");
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
});
