/**
 * Field spec: maps every attribute of the MOA PropertyInformation layer to a
 * typed column in the lake. All staging/select/hash SQL is generated from this
 * single list so the three never drift apart.
 *
 * `epochMillis` fields arrive from the GeoJSON endpoint as unix epoch
 * milliseconds and are converted to TIMESTAMP at staging time.
 */
export interface FieldSpec {
  /** Attribute name in the ArcGIS layer / raw NDJSON. */
  src: string;
  /** Column name in the lake. */
  dst: string;
  /** DuckDB type of the lake column. */
  type: string;
  epochMillis?: boolean;
  /**
   * Export metadata rather than parcel data (e.g. PUBDATE, the upstream
   * publish timestamp): stored, but excluded from the change-detection hash so
   * it never creates a spurious history version, and aggregated as max()
   * because multi-part parcels carry a different value on each part.
   */
  volatile?: boolean;
}

/**
 * Plausible window for the YearBuilt family. The source carries sentinels and
 * typos (literal 1, 1190, and future years 2030–2036 observed 2026-07):
 * nothing in the municipality predates the oldest gold-rush-era structures,
 * and a building cannot be built later than next year. cleanSnapshot
 * (pipeline.ts) nullifies values outside the window; the year_built_plausible
 * audit check asserts the same window over the lake.
 */
export const YEAR_BUILT_FLOOR = 1850;
export const YEAR_BUILT_CEILING_SQL = `(extract(year FROM current_date) + 1)`;

/** TRUE when expr holds a plausible year-built value; FALSE on anything else (including NULL). */
export function plausibleYearPredicateSql(expr: string): string {
  return `coalesce(TRY_CAST(${expr} AS INTEGER) BETWEEN ${YEAR_BUILT_FLOOR} AND ${YEAR_BUILT_CEILING_SQL}, false)`;
}

export const FIELDS: FieldSpec[] = [
  { src: "Appraisal_Year", dst: "appraisal_year", type: "INTEGER" },
  { src: "Parcel_ID_URL", dst: "parcel_id_url", type: "VARCHAR" },
  { src: "Property_Type", dst: "property_type", type: "VARCHAR" },
  { src: "Class", dst: "class", type: "VARCHAR" },
  { src: "Land_Use", dst: "land_use", type: "VARCHAR" },
  { src: "Owner_Line_1", dst: "owner_line_1", type: "VARCHAR" },
  { src: "Owner_Line_2", dst: "owner_line_2", type: "VARCHAR" },
  { src: "Owner_Line_3", dst: "owner_line_3", type: "VARCHAR" },
  { src: "Owner_Line_4", dst: "owner_line_4", type: "VARCHAR" },
  { src: "Owner_Name", dst: "owner_name", type: "VARCHAR" },
  { src: "Owner_Address", dst: "owner_address", type: "VARCHAR" },
  { src: "Owner_City", dst: "owner_city", type: "VARCHAR" },
  { src: "Owner_State", dst: "owner_state", type: "VARCHAR" },
  { src: "Owner_Zip", dst: "owner_zip", type: "VARCHAR" },
  { src: "Legal_Description", dst: "legal_description", type: "VARCHAR" },
  { src: "Parcel_Address", dst: "parcel_address", type: "VARCHAR" },
  { src: "Condo_Unit_Number", dst: "condo_unit_number", type: "VARCHAR" },
  { src: "Total_Living_Units", dst: "total_living_units", type: "INTEGER" },
  { src: "Lot_Size", dst: "lot_size", type: "BIGINT" },
  { src: "Zoning_District", dst: "zoning_district", type: "VARCHAR" },
  { src: "Grid_Map", dst: "grid_map", type: "VARCHAR" },
  { src: "HRA_Number", dst: "hra_number", type: "VARCHAR" },
  { src: "Tax_District", dst: "tax_district", type: "VARCHAR" },
  { src: "Deed_Book", dst: "deed_book", type: "INTEGER" },
  { src: "Deed_Page", dst: "deed_page", type: "INTEGER" },
  { src: "Plat_Number", dst: "plat_number", type: "VARCHAR" },
  { src: "Appraised_Land_Value", dst: "appraised_land_value", type: "DOUBLE" },
  { src: "Appraised_Building_Value", dst: "appraised_building_value", type: "DOUBLE" },
  { src: "Appraised_Total_Value", dst: "appraised_total_value", type: "DOUBLE" },
  { src: "Exemption_1_Type", dst: "exemption_1_type", type: "VARCHAR" },
  { src: "Exemption_1_Amount", dst: "exemption_1_amount", type: "DOUBLE" },
  { src: "Exemption_2_Type", dst: "exemption_2_type", type: "VARCHAR" },
  { src: "Exemption_2_Amount", dst: "exemption_2_amount", type: "DOUBLE" },
  { src: "Exemption_5_Type", dst: "exemption_5_type", type: "VARCHAR" },
  { src: "Exemption_5_Amount", dst: "exemption_5_amount", type: "DOUBLE" },
  { src: "Exemption_6_Type", dst: "exemption_6_type", type: "VARCHAR" },
  { src: "Exemption_6_Amount", dst: "exemption_6_amount", type: "DOUBLE" },
  { src: "Total_Exemptions", dst: "total_exemptions", type: "DOUBLE" },
  { src: "Exemption_Types_All", dst: "exemption_types_all", type: "VARCHAR" },
  { src: "Exemption_Type_Group", dst: "exemption_type_group", type: "VARCHAR" },
  { src: "Taxable_Value", dst: "taxable_value", type: "DOUBLE" },
  { src: "NetTaxableValue", dst: "net_taxable_value", type: "DOUBLE" },
  { src: "Land_Value_Previous", dst: "land_value_previous", type: "DOUBLE" },
  { src: "Building_Value_Previous", dst: "building_value_previous", type: "DOUBLE" },
  { src: "Total_Value_Previous", dst: "total_value_previous", type: "DOUBLE" },
  { src: "Land_Value_Previous_2", dst: "land_value_previous_2", type: "DOUBLE" },
  { src: "Building_Value_Previous_2", dst: "building_value_previous_2", type: "DOUBLE" },
  { src: "Total_Value_Previous_2", dst: "total_value_previous_2", type: "DOUBLE" },
  { src: "YearBuilt", dst: "year_built", type: "VARCHAR" },
  { src: "YearBuilt_Min", dst: "year_built_min", type: "SMALLINT" },
  { src: "YearBuilt_Max", dst: "year_built_max", type: "SMALLINT" },
  { src: "EffectiveYear", dst: "effective_year", type: "VARCHAR" },
  { src: "Location", dst: "location", type: "VARCHAR" },
  { src: "CBook_Page", dst: "cbook_page", type: "VARCHAR" },
  { src: "Deed_Date", dst: "deed_date", type: "TIMESTAMP", epochMillis: true },
  { src: "PUBDATE", dst: "pubdate", type: "TIMESTAMP", epochMillis: true, volatile: true },
  { src: "GIS_Category", dst: "gis_category", type: "VARCHAR" },
  { src: "GIS_Card_Number", dst: "gis_card_number", type: "VARCHAR" },
  { src: "GIS_Site_Street_Number", dst: "gis_site_street_number", type: "VARCHAR" },
  { src: "GIS_Site_Street_Pre", dst: "gis_site_street_pre", type: "VARCHAR" },
  { src: "GIS_Site_Street_Name", dst: "gis_site_street_name", type: "VARCHAR" },
  { src: "GIS_Site_Street_Type", dst: "gis_site_street_type", type: "VARCHAR" },
  { src: "GIS_Site_Street_Suf", dst: "gis_site_street_suf", type: "VARCHAR" },
  { src: "GIS_Site_City", dst: "gis_site_city", type: "VARCHAR" },
  { src: "GIS_Site_State", dst: "gis_site_state", type: "VARCHAR" },
  { src: "GIS_Site_Zipcode", dst: "gis_site_zipcode", type: "VARCHAR" },
  { src: "GIS_Economic_Unit", dst: "gis_economic_unit", type: "VARCHAR" },
  { src: "GIS_ParcelNum8", dst: "gis_parcelnum8", type: "VARCHAR" },
  { src: "GIS_ParcelNum8Formatted", dst: "gis_parcelnum8_formatted", type: "VARCHAR" },
  { src: "GIS_ParcelNum11", dst: "gis_parcelnum11", type: "VARCHAR" },
  { src: "GIS_ParcelNum11Formatted", dst: "gis_parcelnum11_formatted", type: "VARCHAR" },
  { src: "GIS_MeanPercentSlope", dst: "gis_mean_percent_slope", type: "DOUBLE" },
  { src: "CAMA_Acreage", dst: "cama_acreage", type: "DOUBLE" },
  { src: "Tax_District_CurrApprYear", dst: "tax_district_curr_appr_year", type: "VARCHAR" },
];

/** Attribute fields requested from ArcGIS (spec fields + key/ordering fields). */
export const OUT_FIELDS = ["Parcel_ID", "Parcel_ID_Count", ...FIELDS.map((f) => f.src)];

const q = (name: string) => `"${name}"`;

/** columns={...} object literal for read_json over the raw NDJSON. */
export function stagingColumnsSql(): string {
  const cols = [
    `'Parcel_ID': 'VARCHAR'`,
    `'Parcel_ID_Count': 'INTEGER'`,
    ...FIELDS.map((f) => `'${f.src}': '${f.epochMillis ? "BIGINT" : f.type}'`),
    `'__geometry': 'VARCHAR'`,
  ];
  return `{${cols.join(", ")}}`;
}

/**
 * Aggregated select expressions collapsing multi-row parcels to one row.
 * Multi-part parcels repeat attributes across rows; arg_min picks the first
 * card (lowest Parcel_ID_Count). Parcel_ID_Count alone can tie, and DuckDB's
 * parallel arg_min breaks ties nondeterministically across runs, so the
 * ordering key is made content-deterministic with a geometry-hash suffix.
 */
export function aggregatedFieldSql(): string {
  const orderKey = `concat(lpad(coalesce("Parcel_ID_Count", 0)::VARCHAR, 6, '0'), md5(coalesce(__geometry, '')))`;
  return FIELDS.map((f) => {
    const raw = f.volatile ? `max(${q(f.src)})` : `arg_min(${q(f.src)}, ${orderKey})`;
    const expr = f.epochMillis ? `to_timestamp(${raw} / 1000.0)::TIMESTAMP` : raw;
    return `${expr} AS ${q(f.dst)}`;
  }).join(",\n    ");
}

/** Lake column DDL for the metadata fields. */
export function lakeColumnsDdl(): string {
  return FIELDS.map((f) => `${q(f.dst)} ${f.type}`).join(",\n  ");
}

/** Ordered metadata column name list (shared by INSERT and SELECT). */
export function lakeColumnNames(): string[] {
  return FIELDS.map((f) => f.dst);
}

/** Change-detection hash over all non-volatile metadata columns + geometry WKB. */
export function attrHashSql(geomWkbExpr: string): string {
  const parts = FIELDS.filter((f) => !f.volatile).map((f) => `coalesce(CAST(${q(f.dst)} AS VARCHAR), '')`);
  return `md5(concat_ws('|', ${parts.join(", ")}, hex(${geomWkbExpr})))`;
}
