/**
 * Catalog of every exemption value observed in the MOA PropertyInformation
 * layer (full history through 2026-07-05). The layer publishes these as free
 * strings — no ArcGIS coded-value domain — so this list is maintained by
 * observation, and the exemption checks in src/checks.ts warn whenever the
 * muni starts publishing a value that isn't here yet.
 *
 * How the exemption columns fit together:
 *
 * - The layer has four slots: 1, 2, 5 and 6 (3 and 4 do not exist upstream).
 *   Each slot is a (type, amount) pair; a slot's type is non-null exactly
 *   when its amount is nonzero.
 *   - Slots 1–2 hold institutional exemptions (government / religious /
 *     charitable / non-profit ownership and the like). Each institutional
 *     type also occurs with a " - LAND" suffix when only the land portion is
 *     exempt; a building+land exemption occupies both slots ("RELIGIOUS ORG"
 *     in slot 1, "RELIGIOUS ORG - LAND" in slot 2).
 *   - Slot 5 holds the personal state-mandated exemptions (senior citizen,
 *     disabled veteran, military widow(er)).
 *   - Slot 6 holds only the residential exemption, "OWNERS PRIMARY RESIDENCE".
 * - `total_exemptions` equals the sum of the four amounts exactly.
 * - `exemption_types_all` is an upstream convenience concatenation of the
 *   four types. It is lossy — empty slots leave double spaces and the string
 *   is truncated at 100 characters — so query the slot columns, not it.
 * - `exemption_type_group` takes only two values: 'No Exemptions' when all
 *   four slots are empty, 'Other' otherwise.
 *
 * How exemptions relate to taxable value:
 *
 * - `taxable_value` = `appraised_total_value` − `total_exemptions`, exactly,
 *   on every parcel — with two quirks. First, a zero difference is stored
 *   two distinct ways, and the split is meaningful (verified disjoint
 *   against the live layer on 2026-07-06): NULL means the parcel is
 *   *unvalued* — no appraisal and no exemptions (rights-of-way, condo
 *   master records; 1,136 parcels) — while an explicit 0 means *valued but
 *   fully exempted* — appraised > 0, entirely offset by exemptions (5,901
 *   parcels). The importer deliberately preserves that NULL; use
 *   coalesce(taxable_value, 0) for arithmetic, `IS NULL` to find unvalued
 *   parcels. Second, it goes *negative* on a handful of over-exempted
 *   parcels (6 on 2026-07-05, e.g. a senior exemption capped above a low
 *   appraised value).
 * - `net_taxable_value` (upstream `NetTaxableValue`) is never NULL and never
 *   negative, and equals greatest(taxable_value, 0) on 99.86% of parcels.
 *   On the rest (134 on 2026-07-05, skewed toward high-value parcels —
 *   hospitals, big commercial, some residential) it diverges in both
 *   directions by up to tens of millions: it carries a number from the
 *   muni's tax-roll side that the CAMA appraisal/exemption columns cannot
 *   reproduce. Use `taxable_value` when relating values to exemptions;
 *   treat `net_taxable_value` as its own upstream fact.
 */
import { sqlStr } from "./quote.js";

/**
 * Institutional exemption types (slots 1–2), with the " - LAND" suffix
 * stripped; see institutionalBase(). "NAVITE GROUPS / CORP OWNED" is the
 * muni's own misspelling of NATIVE, faithfully preserved. "RIGHT-OF-WAY
 * LAND" is a complete type name, not a " - LAND" variant.
 */
export const INSTITUTIONAL_EXEMPTION_BASES = [
  "AFFORDABLE AND WORKFORCE HOUSING (AMC 12.70)",
  "CHARITABLE ORG / GROUPS",
  "CHARTER SCHOOL",
  "COMMON AREA",
  "COMMUNITY / PUBLIC USE",
  "CONDO DEVL MASTER RECORD",
  "DETERIORATED PROPS",
  "DOWNTOWN RESI-DEV",
  "FARM USE (AMC 12.15)",
  "FARM/AGRICULTURAL (AS 29.45.060)",
  "FEDERALLY OWNED",
  "HOMEOWNERS ASSOC - OWN/USE",
  "HOUSING AUTHORITY (NON-GOV)",
  "MOA OWNED (EXC. SCHOOLS)",
  "MOA OWNED SCHOOLS",
  "NATIVE GROUPS / CORP OWNED",
  "NAVITE GROUPS / CORP OWNED",
  "NON-PROFIT CEMETERY",
  "NON-PROFIT EDUCATION",
  "NON-PROFIT HOSPITALS",
  "NON-PROFIT UTILITIES",
  "NON-PROFIT VET ORG / CLUB",
  "RELIGIOUS HOUSING",
  "RELIGIOUS ORG",
  "RIGHT-OF-WAY LAND",
  "SPECIFIC TO CONDO PROJECT",
  "STATE OWNED (EXC. SCHOOLS)",
  "STATE OWNED SCHOOL",
  "SUBDIVISION",
] as const;

/** Personal exemption types (slot 5). */
export const PERSONAL_EXEMPTION_TYPES = [
  "DISABLED VET: SELF",
  "DISABLED VET: WIDOW(ER)",
  "MILITARY SERVICE: WIDOW(ER)",
  "MILITARY SERVICE: WIDOW(ER) OTHER",
  "PERM DISABLED VET: SELF",
  "PERM DISABLED VET: WIDOW(ER)",
  "SENIOR SELF: PRIMARY RESI",
  "SENIOR: WIDOW(ER)",
] as const;

/** Residential exemption types (slot 6). */
export const RESIDENTIAL_EXEMPTION_TYPES = ["OWNERS PRIMARY RESIDENCE"] as const;

/** The only two values exemption_type_group takes. */
export const EXEMPTION_TYPE_GROUPS = ["No Exemptions", "Other"] as const;

export type InstitutionalExemptionBase =
  (typeof INSTITUTIONAL_EXEMPTION_BASES)[number];
/**
 * An institutional type as it appears in slots 1–2: a base name or its
 * " - LAND" variant. (A superset — not every base occurs with the suffix.)
 */
export type InstitutionalExemptionType =
  | InstitutionalExemptionBase
  | `${InstitutionalExemptionBase} - LAND`;
export type PersonalExemptionType = (typeof PERSONAL_EXEMPTION_TYPES)[number];
export type ResidentialExemptionType =
  (typeof RESIDENTIAL_EXEMPTION_TYPES)[number];
export type ExemptionTypeGroup = (typeof EXEMPTION_TYPE_GROUPS)[number];

/** Base name of an institutional exemption: "RELIGIOUS ORG - LAND" → "RELIGIOUS ORG". */
export function institutionalBase(
  type: InstitutionalExemptionType,
): InstitutionalExemptionBase;
/** String overload for unvetted upstream values (see test/exemptions.test.ts). */
export function institutionalBase(type: string): string;
export function institutionalBase(type: string): string {
  return type.replace(/ - LAND$/, "");
}

// ---------------------------------------------------------------------------
// Owner-type categorization: the `exemptions` schema shipped inside the
// archive.
//
// Some exemption values can only be true of a particular kind of owner — a
// religious-organization exemption is granted to a religious organization;
// the owner's-primary-residence exemption to a natural person living there.
// That observation is a labeling rule that needs no model, and it labels
// about 52% of parcels. The rule's design principle is *abstain, never
// guess*: a NULL owner_type is a correct answer, a wrong one is not.
//
// The rule ships inside the published archive as a schema named `exemptions`
// (created by ensureSchema at ingest), so any reader — notebooks, duckdb-cli,
// other tools — can classify without reimplementing it:
//
//   exemptions.owner_identifying          rules table: base → owner_type
//   exemptions.use_identifying            rules table: bases that say nothing
//                                         about the owner
//   exemptions.institutional_base(t)      scalar macro: normalize a slot-1/2
//                                         value to its base
//   exemptions.categorize_by_exemption(t) table macro: every source column
//                                         plus owner_type and basis
//
// The macro bakes the rules into its body rather than joining the tables:
// DuckDB expands a macro in the *caller's* context, so a table reference
// like `exemptions.owner_identifying` would resolve only under the alias the
// archive happens to be attached as. Both are generated from the constants
// below, so they cannot drift; test/exemptions.test.ts pins the behavior and
// src/checks.ts audits the shipped data against the assumptions.
//
// The evidence behind each classification (top owner names per base, the
// known ~3% impurity of NATIVE GROUPS / CORP OWNED, etc.) is presented in
// notebooks/owner_type_from_exemptions.py.

/** The label vocabulary the rule can produce; anything else is an abstention (NULL). */
export const OWNER_TYPES = ["government", "native_corp", "nonprofit", "hoa", "person"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/**
 * Institutional bases (slots 1–2, normalized) that identify *who owns* the
 * parcel — you get these because of who you are. Together with
 * USE_IDENTIFYING_BASES this partitions the normalized
 * INSTITUTIONAL_EXEMPTION_BASES (the NAVITE typo folds into NATIVE).
 */
export const OWNER_IDENTIFYING_BASES = {
  "FEDERALLY OWNED": "government",
  "MOA OWNED (EXC. SCHOOLS)": "government",
  "MOA OWNED SCHOOLS": "government",
  "STATE OWNED (EXC. SCHOOLS)": "government",
  "STATE OWNED SCHOOL": "government",
  "NATIVE GROUPS / CORP OWNED": "native_corp",
  "RELIGIOUS ORG": "nonprofit",
  "RELIGIOUS HOUSING": "nonprofit",
  "CHARITABLE ORG / GROUPS": "nonprofit",
  "NON-PROFIT CEMETERY": "nonprofit",
  "NON-PROFIT EDUCATION": "nonprofit",
  "NON-PROFIT HOSPITALS": "nonprofit",
  "NON-PROFIT UTILITIES": "nonprofit",
  "NON-PROFIT VET ORG / CLUB": "nonprofit",
  "CHARTER SCHOOL": "nonprofit",
  "HOUSING AUTHORITY (NON-GOV)": "nonprofit",
  "COMMUNITY / PUBLIC USE": "nonprofit",
  "HOMEOWNERS ASSOC - OWN/USE": "hoa",
} satisfies Readonly<Record<string, OwnerType>>;

/**
 * Institutional bases that identify *what the parcel is or how it is used* —
 * you get these because of the land, and the owner can be anyone (SUBDIVISION
 * is a builder's unsold-lot deferral; COMMON AREA attaches to the lot).
 * Mapping these to an owner type would be a category error; the macro refuses
 * to label them.
 */
export const USE_IDENTIFYING_BASES = [
  "AFFORDABLE AND WORKFORCE HOUSING (AMC 12.70)",
  "COMMON AREA",
  "CONDO DEVL MASTER RECORD",
  "DETERIORATED PROPS",
  "DOWNTOWN RESI-DEV",
  "FARM USE (AMC 12.15)",
  "FARM/AGRICULTURAL (AS 29.45.060)",
  "RIGHT-OF-WAY LAND",
  "SPECIFIC TO CONDO PROJECT",
  "SUBDIVISION",
] as const;

/**
 * Slots 5–6 are statutorily restricted to natural persons, so they imply
 * `person` — unless the owner name says otherwise, in which case the macro
 * abstains rather than guesses. Both guards are one-directional: they can
 * only remove a `person` label, never add one. A trust name is not a
 * contradiction (a trust may hold a primary residence) but whether that owner
 * is a `person` is a taxonomy question the muni's data cannot settle; a
 * corporate name with a primary-residence exemption is a contradiction
 * outright (stale owner name after a sale, or exemption fraud).
 */
export const TRUST_NAME_TOKEN = "TRUST";
export const CORPORATE_NAME_PATTERN = String.raw`(^| )(LLC|INC|CORP|LP|LTD)(\.|,|$| )`;

/** basis values on labeled rows (owner_type non-NULL). */
export const OWNER_TYPE_LABELED_BASES = ["owner_identifying_exemption", "person_exemption"] as const;
/** basis values on abstained rows (owner_type NULL). */
export const OWNER_TYPE_ABSTAINED_BASES = [
  "person_exemption_trust_named",
  "person_exemption_corporate_named",
  "use_based_exemption_only",
  "no_exemption",
] as const;

/**
 * SQL expression normalizing a slot-1/2 value to its base: strips the
 * " - LAND" suffix and folds the muni's NAVITE misspelling into NATIVE.
 * The single definition behind exemptions.institutional_base, the
 * categorize_by_exemption macro, and the audit checks.
 */
export const institutionalBaseSql = (expr: string) =>
  `replace(regexp_replace(${expr}, ' - LAND$', ''), 'NAVITE', 'NATIVE')`;

/**
 * DDL for the `exemptions` schema, one statement per entry. Idempotent
 * (CREATE OR REPLACE throughout), so every ingest refreshes the shipped rules
 * to match this file. Run only against the archive opened as the *primary*
 * database — see openStore on why persisted catalog entries must be born
 * unqualified.
 *
 * Every object carries a COMMENT ON, so readers of the published file can
 * pull the docs at runtime from duckdb_tables(), duckdb_columns(), and
 * duckdb_functions() without this repo at hand. CREATE OR REPLACE drops
 * comments along with the object, so they are (re)applied after each create.
 */
export function exemptionsSchemaSql(): string[] {
  const ownerRows = Object.entries(OWNER_IDENTIFYING_BASES)
    .map(([base, ownerType]) => `(${sqlStr(base)}, ${sqlStr(ownerType)})`)
    .join(",\n      ");
  const useRows = USE_IDENTIFYING_BASES.map((base) => `(${sqlStr(base)})`).join(",\n      ");
  const cases = Object.entries(OWNER_IDENTIFYING_BASES)
    .map(([base, ownerType]) => `WHEN institutional_base = ${sqlStr(base)} THEN ${sqlStr(ownerType)}`)
    .join("\n            ");

  return [
    `CREATE SCHEMA IF NOT EXISTS exemptions`,

    `CREATE OR REPLACE TABLE exemptions.owner_identifying AS
     SELECT * FROM (VALUES
      ${ownerRows}
     ) t(base, owner_type)`,

    `CREATE OR REPLACE TABLE exemptions.use_identifying AS
     SELECT * FROM (VALUES
      ${useRows}
     ) t(base)`,

    `CREATE OR REPLACE MACRO exemptions.institutional_base(exemption_type) AS
     ${institutionalBaseSql("exemption_type")}`,

    `CREATE OR REPLACE MACRO exemptions.categorize_by_exemption(source_table) AS TABLE
WITH normalized AS (
  SELECT
    *,
    -- Slot 2 carries the exemption alone on parcels with no building; the
    -- " - LAND" suffix marks a land-only exemption; NAVITE is the muni's own
    -- misspelling of NATIVE, faithfully preserved upstream.
    ${institutionalBaseSql("coalesce(exemption_1_type, exemption_2_type)")} AS institutional_base,
    coalesce(exemption_5_type, exemption_6_type) IS NOT NULL AS has_person_exemption,
    contains(coalesce(owner_name, ''), ${sqlStr(TRUST_NAME_TOKEN)}) AS trust_named,
    regexp_matches(coalesce(owner_name, ''), ${sqlStr(CORPORATE_NAME_PATTERN)}) AS corporate_named
  FROM query_table(source_table)
), classified AS (
  SELECT *, CASE
            ${cases}
            ELSE NULL
            END AS institutional_owner_type
  FROM normalized
)
SELECT
  * EXCLUDE (
    institutional_base, has_person_exemption, trust_named,
    corporate_named, institutional_owner_type
  ),
  CASE
    WHEN institutional_owner_type IS NOT NULL THEN institutional_owner_type
    WHEN has_person_exemption AND NOT trust_named AND NOT corporate_named THEN 'person'
  END AS owner_type,
  CASE
    WHEN institutional_owner_type IS NOT NULL       THEN 'owner_identifying_exemption'
    WHEN has_person_exemption AND trust_named       THEN 'person_exemption_trust_named'
    WHEN has_person_exemption AND corporate_named   THEN 'person_exemption_corporate_named'
    WHEN has_person_exemption                       THEN 'person_exemption'
    WHEN institutional_base IS NOT NULL             THEN 'use_based_exemption_only'
    ELSE                                                 'no_exemption'
  END AS basis
FROM classified`,

    `COMMENT ON TABLE exemptions.owner_identifying IS ${sqlStr(
      "Slot-1/2 exemption bases granted because of WHO owns the parcel, each mapped to the " +
      "owner type it proves. Bases are normalized: ' - LAND' suffix stripped, the muni's " +
      "NAVITE typo folded into NATIVE (see exemptions.institutional_base). Together with " +
      "exemptions.use_identifying this partitions every observed institutional base. " +
      "Generated at ingest from src/exemptions.ts; the evidence behind each mapping is in " +
      "notebooks/owner_type_from_exemptions.py.",
    )}`,
    `COMMENT ON COLUMN exemptions.owner_identifying.base IS ${sqlStr(
      "Normalized institutional exemption base, as returned by " +
      "exemptions.institutional_base(coalesce(exemption_1_type, exemption_2_type)).",
    )}`,
    `COMMENT ON COLUMN exemptions.owner_identifying.owner_type IS ${sqlStr(
      `The kind of owner this exemption proves: one of ${OWNER_TYPES.filter((t) => t !== "person").join(", ")}.`,
    )}`,

    `COMMENT ON TABLE exemptions.use_identifying IS ${sqlStr(
      "Slot-1/2 exemption bases granted because of WHAT the parcel is or how it is used " +
      "(SUBDIVISION is a builder's unsold-lot deferral, COMMON AREA attaches to the lot, ...). " +
      "They say nothing about the owner, so exemptions.categorize_by_exemption refuses to " +
      "label them (basis = 'use_based_exemption_only'). Generated at ingest from " +
      "src/exemptions.ts.",
    )}`,
    `COMMENT ON COLUMN exemptions.use_identifying.base IS ${sqlStr(
      "Normalized institutional exemption base, as returned by " +
      "exemptions.institutional_base(coalesce(exemption_1_type, exemption_2_type)).",
    )}`,

    `COMMENT ON MACRO exemptions.institutional_base IS ${sqlStr(
      "Normalize a slot-1/2 exemption type to its base: strips the ' - LAND' suffix (marking a " +
      "land-only exemption) and folds the muni's NAVITE misspelling into NATIVE. " +
      "Example: institutional_base('RELIGIOUS ORG - LAND') = 'RELIGIOUS ORG'.",
    )}`,

    `COMMENT ON MACRO TABLE exemptions.categorize_by_exemption IS ${sqlStr(
      "Label WHO owns each parcel from its exemption slots, abstaining wherever they cannot " +
      "settle it. Takes the name of a table/view exposing owner_name and " +
      "exemption_{1,2,5,6}_type; returns every source column plus owner_type (one of " +
      `${OWNER_TYPES.join(", ")}, or NULL when abstaining and basis (why, never NULL: ` +
      `${[...OWNER_TYPE_LABELED_BASES, ...OWNER_TYPE_ABSTAINED_BASES].join(", ")}). ` +
      "Labels ~52% of parcels. Usage: " +
      "FROM exemptions.categorize_by_exemption('lake.parcels_current').",
    )}`,
  ];
}
