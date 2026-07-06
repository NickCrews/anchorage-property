/**
 * Catalog of every exemption value observed in the MOA PropertyInformation
 * layer (full history through 2026-07-05). The layer publishes these as free
 * strings — no ArcGIS coded-value domain — so this list is maintained by
 * observation and test/exemptions.test.ts fails whenever the muni starts
 * publishing a value that isn't here yet.
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
 *   on every parcel — with two quirks. When the difference is 0 (fully
 *   exempt or zero-value parcels) the column holds either 0 or NULL, so
 *   compare through coalesce(taxable_value, 0). And it goes *negative* on a
 *   handful of over-exempted parcels (6 on 2026-07-05, e.g. a senior
 *   exemption capped above a low appraised value).
 * - `net_taxable_value` (upstream `NetTaxableValue`) is never NULL and never
 *   negative, and equals greatest(taxable_value, 0) on 99.86% of parcels.
 *   On the rest (134 on 2026-07-05, skewed toward high-value parcels —
 *   hospitals, big commercial, some residential) it diverges in both
 *   directions by up to tens of millions: it carries a number from the
 *   muni's tax-roll side that the CAMA appraisal/exemption columns cannot
 *   reproduce. Use `taxable_value` when relating values to exemptions;
 *   treat `net_taxable_value` as its own upstream fact.
 */

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
