/**
 * Data-quality checks over the published artifacts — the single definition
 * shared by everything that gates or audits data:
 *
 *   - `push` runs the error-severity checks in-process against the copy it is
 *     about to upload and refuses to upload on any failure;
 *   - `audit` runs the full suite from the CLI against any copy (the
 *     workspace's by default, or the published URLs with --published).
 *
 * One list, so the gate and the audit can never drift. Code tests live in
 * test/ and run with vitest; assertions about the *data* live here.
 *
 * Each check's SQL returns the number of VIOLATING rows; the check passes
 * when that count is <= allowance.
 *
 * severity 'error'  → known-impossible states; the check fails.
 * severity 'warn'   → real-world dirtiness we tolerate up to an allowance
 *                     (e.g. a couple of genuine ~1 m² sliver parcels and a
 *                     handful of OGC-invalid rings in the source); beyond the
 *                     allowance the check reports 'warn' but does not fail.
 *
 * The SQL expects the archive ATTACHed as `lake` and the browser artifact as
 * `browser` — use openCheckConnection(). Attaching under an alias (rather
 * than opening the archive as the primary database) is deliberate: a view
 * whose persisted body carries a stale catalog qualification only breaks when
 * read through a different alias, so these checks catch that before readers
 * do.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  CORPORATE_NAME_PATTERN,
  INSTITUTIONAL_EXEMPTION_BASES,
  OWNER_TYPE_ABSTAINED_BASES,
  OWNER_TYPE_LABELED_BASES,
  OWNER_TYPES,
  PERSONAL_EXEMPTION_TYPES,
  RESIDENTIAL_EXEMPTION_TYPES,
  TRUST_NAME_TOKEN,
  institutionalBaseSql,
} from "./exemptions.js";
import { plausibleYearPredicateSql } from "./fields.js";
import { sqlList, sqlStr } from "./quote.js";

export interface Check {
  name: string;
  severity: "error" | "warn";
  description: string;
  sql: string;
  allowance?: number;
  /** SQL returning up to 5 sample offending rows, for the failure message. */
  sampleSql?: string;
}

export const CHECKS: Check[] = [
  {
    name: "current_count_min",
    severity: "error",
    description: "Anchorage has ~98.5k parcels; far fewer current rows means a broken ingest",
    sql: `SELECT CASE WHEN count(*) < 90000 THEN 1 ELSE 0 END FROM lake.parcels_current`,
  },
  {
    name: "parcel_id_nonempty",
    severity: "error",
    description: "every version row has a non-empty parcel_id",
    sql: `SELECT count(*) FROM lake.parcels WHERE parcel_id IS NULL OR parcel_id = ''`,
  },
  {
    name: "one_current_per_parcel",
    severity: "error",
    description: "SCD2 invariant: at most one current version per parcel",
    sql: `SELECT count(*) FROM (
            SELECT parcel_id FROM lake.parcels WHERE is_current GROUP BY parcel_id HAVING count(*) > 1
          )`,
    sampleSql: `SELECT parcel_id, count(*) AS n FROM lake.parcels WHERE is_current
                GROUP BY parcel_id HAVING count(*) > 1 LIMIT 5`,
  },
  {
    name: "no_overlapping_versions",
    severity: "error",
    description: "SCD2 invariant: a parcel's validity intervals do not overlap",
    sql: `SELECT count(*) FROM (
            SELECT parcel_id,
                   lead(valid_from) OVER (PARTITION BY parcel_id ORDER BY valid_from) AS next_from,
                   valid_to
            FROM lake.parcels
          ) WHERE next_from IS NOT NULL AND (valid_to IS NULL OR next_from < valid_to)`,
  },
  {
    name: "valid_interval_ordered",
    severity: "error",
    description: "valid_to (when closed) is after valid_from",
    sql: `SELECT count(*) FROM lake.parcels WHERE valid_to IS NOT NULL AND valid_to <= valid_from`,
  },
  {
    name: "closed_rows_not_current",
    severity: "error",
    description: "a row is current iff it has no valid_to",
    sql: `SELECT count(*) FROM lake.parcels WHERE is_current <> (valid_to IS NULL)`,
  },
  {
    name: "no_consecutive_duplicate_versions",
    severity: "error",
    description: "merge bug detector: consecutive versions of a parcel must differ in content hash",
    sql: `SELECT count(*) FROM (
            SELECT parcel_id, attr_hash,
                   lag(attr_hash) OVER (PARTITION BY parcel_id ORDER BY valid_from) AS prev_hash
            FROM lake.parcels
          ) WHERE attr_hash = prev_hash`,
  },
  {
    name: "owner_present",
    severity: "warn",
    description:
      "owner_name present on current parcels (verified 2026-07: every keyed parcel has an owner; " +
      "small allowance in case upstream starts publishing ownerless records)",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE owner_name IS NULL OR trim(owner_name) = ''`,
    allowance: 100,
    sampleSql: `SELECT parcel_id, parcel_address, property_type FROM lake.parcels_current
                WHERE owner_name IS NULL OR trim(owner_name) = '' LIMIT 5`,
  },
  {
    name: "ownerless_parcels_have_no_value",
    severity: "error",
    description: "a parcel with a positive appraised value must have an owner",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE (owner_name IS NULL OR trim(owner_name) = '') AND appraised_total_value > 0`,
  },
  {
    name: "geometry_present",
    severity: "error",
    description: "every current parcel has a geometry",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE geom_wkb IS NULL`,
  },
  {
    name: "geometry_valid",
    severity: "warn",
    description: "geometries are OGC-valid (self-intersecting rings etc. tolerated in small numbers)",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE NOT ST_IsValid(ST_GeomFromWKB(geom_wkb))`,
    allowance: 200,
  },
  {
    name: "min_area_1m2",
    severity: "warn",
    description: "no parcel smaller than 1 m² (source has ~2 slivers hovering around 1 m²)",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE area_m2 < 1`,
    allowance: 10,
    sampleSql: `SELECT parcel_id, parcel_address, round(area_m2, 3) AS area_m2 FROM lake.parcels_current
                WHERE area_m2 < 1 ORDER BY area_m2 LIMIT 5`,
  },
  {
    name: "area_positive",
    severity: "error",
    description: "computed parcel area is present and positive",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE area_m2 IS NULL OR area_m2 <= 0`,
  },
  {
    name: "area_not_absurd",
    severity: "error",
    description: "no parcel larger than the whole municipality (~5,000 km²)",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE area_m2 > 5e9`,
  },
  {
    name: "geometry_in_anchorage_bbox",
    severity: "error",
    description: "parcel centroids fall inside the Municipality of Anchorage bounding box",
    sql: `SELECT count(*) FROM (
            SELECT ST_Centroid(ST_GeomFromWKB(geom_wkb)) AS c FROM lake.parcels_current
          ) WHERE NOT (ST_X(c) BETWEEN -151.0 AND -148.3 AND ST_Y(c) BETWEEN 60.6 AND 61.6)`,
  },
  {
    name: "appraised_value_sane",
    severity: "error",
    description: "appraised total value is non-negative and below $5B",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE appraised_total_value IS NOT NULL
            AND (appraised_total_value < 0 OR appraised_total_value > 5e9)`,
  },
  {
    name: "value_components_add_up",
    severity: "warn",
    description:
      "appraised total = land + building on every parcel (exact over all 98,519 parcels on " +
      "2026-07-05; sub-cent tolerance guards against future rounding in the DOUBLE columns)",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE appraised_total_value IS NOT NULL
            AND abs(coalesce(appraised_land_value, 0) + coalesce(appraised_building_value, 0)
                    - appraised_total_value) > 0.005`,
  },
  {
    name: "taxable_le_appraised",
    severity: "warn",
    description: "taxable value does not exceed appraised total",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE taxable_value IS NOT NULL AND appraised_total_value IS NOT NULL
            AND taxable_value > appraised_total_value + 1`,
    allowance: 100,
  },
  {
    name: "appraisal_year_sane",
    severity: "error",
    description: "appraisal year within a plausible window",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE appraisal_year IS NOT NULL AND (appraisal_year < 1990 OR appraisal_year > 2100)`,
  },
  {
    name: "year_built_plausible",
    severity: "error",
    description:
      "year_built / year_built_min / year_built_max within the plausible window shared with " +
      "staging (fields.ts) — the source carries sentinels and typos (literal 1, 1190, future " +
      "years like 2036) and the importer nullifies them",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE (year_built IS NOT NULL AND NOT ${plausibleYearPredicateSql("year_built")})
             OR (year_built_min IS NOT NULL AND NOT ${plausibleYearPredicateSql("year_built_min")})
             OR (year_built_max IS NOT NULL AND NOT ${plausibleYearPredicateSql("year_built_max")})`,
    sampleSql: `SELECT parcel_id, year_built, year_built_min, year_built_max FROM lake.parcels_current
                WHERE (year_built IS NOT NULL AND NOT ${plausibleYearPredicateSql("year_built")})
                   OR (year_built_min IS NOT NULL AND NOT ${plausibleYearPredicateSql("year_built_min")})
                   OR (year_built_max IS NOT NULL AND NOT ${plausibleYearPredicateSql("year_built_max")})
                LIMIT 5`,
  },
  {
    name: "source_freshness",
    severity: "warn",
    description: "upstream PUBDATE within 7 days (layer pauses on weekends/holidays)",
    sql: `SELECT CASE WHEN max(pubdate) < (now() AT TIME ZONE 'UTC') - INTERVAL 7 DAY THEN 1 ELSE 0 END
          FROM lake.parcels_current`,
  },
  {
    name: "ingest_freshness",
    severity: "error",
    description: "a successful ingest ran within the last 48 hours",
    sql: `SELECT CASE WHEN max(finished_at) IS NULL
                      OR max(finished_at) < (now() AT TIME ZONE 'UTC') - INTERVAL 48 HOUR THEN 1 ELSE 0 END
          FROM lake.ingest_runs WHERE status = 'success'`,
  },
  {
    name: "no_future_valid_from",
    severity: "error",
    description: "no version starts in the future",
    sql: `SELECT count(*) FROM lake.parcels WHERE valid_from > (now() AT TIME ZONE 'UTC') + INTERVAL 1 HOUR`,
  },
  // -------------------------------------------------------------------------
  // Browser artifact (anchorage-current.duckdb): the derived file must agree
  // with the archive it was built from. The two objects are published
  // separately, so a mismatch here is either an export bug or a reader who
  // caught the bucket mid-refresh.
  {
    name: "browser_row_count_matches_archive",
    severity: "error",
    description: "browser artifact has exactly the archive's current rows — a truncated export cannot ship silently",
    sql: `SELECT CASE WHEN (SELECT count(*) FROM browser.parcels_current)
                    <> (SELECT count(*) FROM lake.parcels_current) THEN 1 ELSE 0 END`,
  },
  {
    name: "browser_drops_heavy_columns",
    severity: "error",
    description: "browser artifact does not carry attr_hash (internal change detection)",
    sql: `SELECT count(*) FROM duckdb_columns()
          WHERE database_name = 'browser' AND table_name = 'parcels_current'
            AND column_name = 'attr_hash'`,
  },
  {
    name: "browser_carries_geometry",
    severity: "error",
    description:
      "browser artifact has a (simplified) polygon wherever the archive has geometry — the map in " +
      "the data app renders parcel outlines from these, so an export that loses them ships a blank map",
    sql: `SELECT count(*) FROM browser.parcels_current b
          JOIN lake.parcels_current l USING (parcel_id)
          WHERE l.geom_wkb IS NOT NULL AND b.geom_wkb IS NULL`,
  },
  {
    name: "browser_carries_centroids",
    severity: "error",
    description:
      "browser artifact has a centroid wherever the archive has geometry — the map's hover-brush " +
      "predicate is a distance test on these",
    sql: `SELECT count(*) FROM browser.parcels_current b
          JOIN lake.parcels_current l USING (parcel_id)
          WHERE l.geom_wkb IS NOT NULL
            AND (b.centroid_lon IS NULL OR b.centroid_lat IS NULL)`,
  },
  // -------------------------------------------------------------------------
  // Exemptions: the catalog in src/exemptions.ts is maintained by observation
  // (the layer has no coded-value domain), and these checks are the tripwire
  // that catches the muni introducing a new exemption type or restructuring
  // the columns. All warn-severity: upstream drift should page a human, not
  // block the nightly publish.
  {
    name: "exemption_institutional_types_known",
    severity: "warn",
    description:
      "every slot-1/2 value, after stripping ' - LAND', is a known institutional base — a new one " +
      "means the muni added an exemption category; eyeball it (watch for upstream typos like " +
      "NAVITE) and add it to INSTITUTIONAL_EXEMPTION_BASES",
    sql: `SELECT count(*) FROM (
            SELECT DISTINCT regexp_replace(v, ' - LAND$', '') AS base FROM (
              SELECT exemption_1_type AS v FROM lake.parcels_current
              UNION ALL
              SELECT exemption_2_type FROM lake.parcels_current
            ) WHERE v IS NOT NULL
          ) WHERE base NOT IN (${sqlList(INSTITUTIONAL_EXEMPTION_BASES)})`,
    sampleSql: `SELECT DISTINCT regexp_replace(v, ' - LAND$', '') AS unknown_base FROM (
                  SELECT exemption_1_type AS v FROM lake.parcels_current
                  UNION ALL
                  SELECT exemption_2_type FROM lake.parcels_current
                ) WHERE v IS NOT NULL
                  AND regexp_replace(v, ' - LAND$', '') NOT IN (${sqlList(INSTITUTIONAL_EXEMPTION_BASES)})
                LIMIT 5`,
  },
  {
    name: "exemption_personal_types_known",
    severity: "warn",
    description:
      "slot 5 holds the personal state-mandated exemptions (senior / disabled vet / military " +
      "widow(er)) and nothing else",
    sql: `SELECT count(*) FROM (
            SELECT DISTINCT exemption_5_type AS v FROM lake.parcels_current
            WHERE exemption_5_type IS NOT NULL
          ) WHERE v NOT IN (${sqlList(PERSONAL_EXEMPTION_TYPES)})`,
    sampleSql: `SELECT DISTINCT exemption_5_type FROM lake.parcels_current
                WHERE exemption_5_type IS NOT NULL
                  AND exemption_5_type NOT IN (${sqlList(PERSONAL_EXEMPTION_TYPES)}) LIMIT 5`,
  },
  {
    name: "exemption_residential_types_known",
    severity: "warn",
    description: "slot 6 holds only the residential exemption",
    sql: `SELECT count(*) FROM (
            SELECT DISTINCT exemption_6_type AS v FROM lake.parcels_current
            WHERE exemption_6_type IS NOT NULL
          ) WHERE v NOT IN (${sqlList(RESIDENTIAL_EXEMPTION_TYPES)})`,
  },
  {
    name: "exemption_group_flag_consistent",
    severity: "warn",
    description:
      "exemption_type_group is exactly the documented two-value flag: 'No Exemptions' iff all " +
      "four slots are empty, 'Other' otherwise — if the muni splits 'Other' into real groups, " +
      "the catalog needs a fresh look",
    sql: `SELECT count(*) FILTER (coalesce(exemption_type_group, '') NOT IN ('No Exemptions', 'Other'))
               + count(*) FILTER (
                   (exemption_type_group = 'No Exemptions') <>
                   (exemption_1_type IS NULL AND exemption_2_type IS NULL
                    AND exemption_5_type IS NULL AND exemption_6_type IS NULL)
                 )
          FROM lake.parcels_current`,
  },
  {
    name: "exemption_type_iff_amount",
    severity: "warn",
    description: "a slot's type is non-null exactly when its amount is nonzero",
    sql: `SELECT count(*) FILTER ((exemption_1_type IS NOT NULL) <> (coalesce(exemption_1_amount, 0) <> 0))
               + count(*) FILTER ((exemption_2_type IS NOT NULL) <> (coalesce(exemption_2_amount, 0) <> 0))
               + count(*) FILTER ((exemption_5_type IS NOT NULL) <> (coalesce(exemption_5_amount, 0) <> 0))
               + count(*) FILTER ((exemption_6_type IS NOT NULL) <> (coalesce(exemption_6_amount, 0) <> 0))
          FROM lake.parcels_current`,
  },
  {
    name: "exemption_total_is_sum",
    severity: "warn",
    description: "total_exemptions = sum of the four slot amounts (sub-cent tolerance)",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE abs(coalesce(total_exemptions, 0)
                    - (coalesce(exemption_1_amount, 0) + coalesce(exemption_2_amount, 0)
                       + coalesce(exemption_5_amount, 0) + coalesce(exemption_6_amount, 0))) > 0.005`,
  },
  {
    name: "taxable_equals_appraised_minus_exemptions",
    severity: "warn",
    description:
      "taxable_value = appraised_total_value − total_exemptions on every parcel (compared through " +
      "coalesce because a zero difference is stored as either 0 or NULL)",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE abs(coalesce(taxable_value, 0)
                    - (coalesce(appraised_total_value, 0) - coalesce(total_exemptions, 0))) > 0.005`,
  },
  {
    name: "taxable_null_zero_semantics",
    severity: "warn",
    description:
      "NULL taxable_value marks an unvalued parcel (no appraisal, no exemptions) and an explicit 0 " +
      "marks a valued-but-fully-exempted one — the split is meaningful, verified disjoint upstream " +
      "2026-07-06, and the importer preserves the NULL",
    sql: `SELECT count(*) FILTER (
            taxable_value IS NULL
            AND (coalesce(appraised_total_value, 0) <> 0 OR coalesce(total_exemptions, 0) <> 0)
          )
        + count(*) FILTER (taxable_value = 0 AND coalesce(total_exemptions, 0) = 0)
          FROM lake.parcels_current`,
  },
  {
    name: "taxable_negative_rare",
    severity: "warn",
    description:
      "taxable_value goes negative only on a handful of over-exempted parcels (6 on 2026-07-05, " +
      "e.g. a senior exemption capped above a low appraised value)",
    sql: `SELECT count(*) FROM lake.parcels_current WHERE taxable_value < 0`,
    allowance: 100,
  },
  {
    name: "net_taxable_never_null_or_negative",
    severity: "warn",
    description: "net_taxable_value (upstream NetTaxableValue) is never NULL and never negative",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE net_taxable_value IS NULL OR net_taxable_value < 0`,
  },
  {
    name: "net_taxable_tracks_taxable",
    severity: "warn",
    description:
      "net_taxable_value = greatest(taxable_value, 0) on ≥99.5% of parcels — the stragglers carry " +
      "a tax-roll-side number the CAMA columns can't reproduce (134 on 2026-07-05); growth here " +
      "means the columns have genuinely diverged and src/exemptions.ts needs a fresh look",
    sql: `SELECT CASE WHEN count(*) FILTER (
                        abs(coalesce(net_taxable_value, 0)
                            - greatest(coalesce(taxable_value, 0), 0)) > 0.005
                      ) > 0.005 * count(*) THEN 1 ELSE 0 END
          FROM lake.parcels_current`,
  },
  // -------------------------------------------------------------------------
  // Owner-type categorization: the `exemptions` schema shipped inside the
  // archive (rules tables + categorize_by_exemption macro, created by
  // ensureSchema at ingest from src/exemptions.ts). Two kinds of check:
  //
  //   - error-severity: the macro's own contract — states that are impossible
  //     if the code is right. Running them through the `lake` alias is itself
  //     part of the test: a persisted macro whose body picked up a catalog
  //     qualification at birth only breaks under a different alias, exactly
  //     like the views (see openCheckConnection).
  //   - warn-severity: upstream assumptions the rule rests on. Drift here
  //     should page a human, not block the nightly publish.
  {
    name: "owner_type_macro_row_preserving",
    severity: "error",
    description: "categorize_by_exemption emits exactly one output row per input row",
    sql: `SELECT abs(
            (SELECT count(*) FROM lake.exemptions.categorize_by_exemption('lake.parcels_current'))
          - (SELECT count(*) FROM lake.parcels_current))`,
  },
  {
    name: "owner_type_basis_known",
    severity: "error",
    description: "basis is never NULL and always drawn from the documented vocabulary",
    sql: `SELECT count(*) FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
          WHERE basis IS NULL
             OR basis NOT IN (${sqlList([...OWNER_TYPE_LABELED_BASES, ...OWNER_TYPE_ABSTAINED_BASES])})`,
  },
  {
    name: "owner_type_label_known",
    severity: "error",
    description: "owner_type is NULL (an abstention) or a known category",
    sql: `SELECT count(*) FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
          WHERE owner_type IS NOT NULL AND owner_type NOT IN (${sqlList(OWNER_TYPES)})`,
  },
  {
    name: "owner_type_null_iff_abstained",
    severity: "error",
    description: "owner_type is non-NULL exactly when basis is a labeling basis",
    sql: `SELECT count(*) FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
          WHERE (owner_type IS NOT NULL) <> (basis IN (${sqlList(OWNER_TYPE_LABELED_BASES)}))`,
  },
  {
    name: "owner_type_person_name_guards",
    severity: "error",
    description:
      "the name guards are one-directional: nothing labeled person carries a trust or corporate " +
      "token in owner_name",
    sql: `SELECT count(*) FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
          WHERE owner_type = 'person'
            AND (contains(owner_name, ${sqlStr(TRUST_NAME_TOKEN)})
                 OR regexp_matches(owner_name, ${sqlStr(CORPORATE_NAME_PATTERN)}))`,
  },
  {
    name: "owner_type_labeled_only_with_exemption",
    severity: "error",
    description: "every labeled parcel carries an exemption — the rule never labels on nothing",
    sql: `SELECT count(*) FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
          WHERE owner_type IS NOT NULL
            AND exemption_1_type IS NULL AND exemption_2_type IS NULL
            AND exemption_5_type IS NULL AND exemption_6_type IS NULL`,
  },
  {
    name: "owner_type_bases_all_classified",
    severity: "warn",
    description:
      "every observed institutional base is classified as owner- or use-identifying in the shipped " +
      "rules tables — an unclassified base means the muni added an exemption category and the " +
      "macro is silently abstaining on it; eyeball the owners and add it to OWNER_IDENTIFYING_BASES " +
      "or USE_IDENTIFYING_BASES in src/exemptions.ts",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE coalesce(exemption_1_type, exemption_2_type) IS NOT NULL
            AND ${institutionalBaseSql("coalesce(exemption_1_type, exemption_2_type)")} NOT IN (
              SELECT base FROM lake.exemptions.owner_identifying
              UNION ALL
              SELECT base FROM lake.exemptions.use_identifying)`,
    sampleSql: `SELECT DISTINCT ${institutionalBaseSql("coalesce(exemption_1_type, exemption_2_type)")} AS unclassified_base
                FROM lake.parcels_current
                WHERE coalesce(exemption_1_type, exemption_2_type) IS NOT NULL
                  AND ${institutionalBaseSql("coalesce(exemption_1_type, exemption_2_type)")} NOT IN (
                    SELECT base FROM lake.exemptions.owner_identifying
                    UNION ALL
                    SELECT base FROM lake.exemptions.use_identifying)
                LIMIT 5`,
  },
  {
    name: "owner_type_signals_never_conflict",
    severity: "warn",
    description:
      "the load-bearing claim behind the rule: no parcel carries both an owner-identifying " +
      "institutional exemption and a personal/residential (slot 5/6) exemption, so the two labels " +
      "can never fight (0 on all 98,519 parcels as of 2026-07-12)",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE ${institutionalBaseSql("coalesce(exemption_1_type, exemption_2_type)")}
                IN (SELECT base FROM lake.exemptions.owner_identifying)
            AND coalesce(exemption_5_type, exemption_6_type) IS NOT NULL`,
    sampleSql: `SELECT parcel_id, owner_name, exemption_1_type, exemption_5_type, exemption_6_type
                FROM lake.parcels_current
                WHERE ${institutionalBaseSql("coalesce(exemption_1_type, exemption_2_type)")}
                      IN (SELECT base FROM lake.exemptions.owner_identifying)
                  AND coalesce(exemption_5_type, exemption_6_type) IS NOT NULL LIMIT 5`,
  },
  {
    name: "exemption_slots_1_2_same_base",
    severity: "warn",
    description:
      "slots 1 and 2 never name different exemption bases — the macro reads " +
      "coalesce(slot 1, slot 2), which is only sound while they agree",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE exemption_1_type IS NOT NULL AND exemption_2_type IS NOT NULL
            AND ${institutionalBaseSql("exemption_1_type")} <> ${institutionalBaseSql("exemption_2_type")}`,
    sampleSql: `SELECT parcel_id, exemption_1_type, exemption_2_type FROM lake.parcels_current
                WHERE exemption_1_type IS NOT NULL AND exemption_2_type IS NOT NULL
                  AND ${institutionalBaseSql("exemption_1_type")} <> ${institutionalBaseSql("exemption_2_type")}
                LIMIT 5`,
  },
  // -------------------------------------------------------------------------
  // Girdwood: executable proof of the README's classification example,
  // tax_district = '4' (the Girdwood Valley Service Area). The data drifts
  // daily, so counts are asserted as tolerant invariants; exact figures as of
  // 2026-07-05 are noted per check. Warn-severity: a shifted boundary is a
  // documentation problem, not a publish blocker.
  {
    name: "girdwood_district_4_sized_right",
    severity: "warn",
    description: "tax district '4' exists (spelled '4', not '04') and is Girdwood-sized (1,851 parcels on 2026-07-05)",
    sql: `SELECT CASE WHEN count(*) BETWEEN 1000 AND 3000 THEN 0 ELSE 1 END
          FROM lake.parcels_current WHERE tax_district = '4'`,
  },
  {
    name: "girdwood_no_foreign_addresses",
    severity: "warn",
    description:
      "the boundary doesn't leak: every district-4 parcel has a Girdwood site address or none at " +
      "all — never Anchorage, Eagle River, Chugiak, or Indian",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE tax_district = '4' AND gis_site_city IS NOT NULL AND gis_site_city <> 'Girdwood'`,
    sampleSql: `SELECT DISTINCT gis_site_city FROM lake.parcels_current
                WHERE tax_district = '4' AND gis_site_city IS NOT NULL AND gis_site_city <> 'Girdwood'
                LIMIT 5`,
  },
  {
    name: "girdwood_addresses_mostly_in_district_4",
    severity: "warn",
    description:
      "the two definitions agree on the core: ≥95% of Girdwood-addressed parcels are in district 4",
    sql: `SELECT CASE WHEN count(*) FILTER (tax_district = '4') >= 0.95 * count(*) THEN 0 ELSE 1 END
          FROM lake.parcels_current WHERE gis_site_city = 'Girdwood'`,
  },
  {
    name: "girdwood_stragglers_only_on_fringe",
    severity: "warn",
    description:
      "Girdwood-addressed parcels outside district 4 sit only in district '15' (the Turnagain Arm " +
      "fringe) or have a blank district — never another numbered district",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE gis_site_city = 'Girdwood' AND tax_district <> '4'
            AND tax_district IS NOT NULL AND tax_district NOT IN ('15', '')`,
    sampleSql: `SELECT DISTINCT tax_district FROM lake.parcels_current
                WHERE gis_site_city = 'Girdwood' AND tax_district <> '4'
                  AND tax_district IS NOT NULL AND tax_district NOT IN ('15', '') LIMIT 5`,
  },
  {
    name: "girdwood_addressless_mostly_vacant",
    severity: "warn",
    description:
      "the district test catches what the address test misses: district 4 holds a few hundred " +
      "address-less parcels, ≥80% of them building-less (290 parcels, 91% vacant, on 2026-07-05)",
    sql: `SELECT CASE WHEN count(*) >= 100
                       AND count(*) FILTER (coalesce(appraised_building_value, 0) = 0) >= 0.8 * count(*)
                      THEN 0 ELSE 1 END
          FROM lake.parcels_current WHERE tax_district = '4' AND gis_site_city IS NULL`,
  },
  {
    name: "girdwood_geometry_in_valley",
    severity: "warn",
    description:
      "district 4 is geographically Girdwood: every parcel's geometry falls inside a generous " +
      "Girdwood-valley bbox, nowhere near the Anchorage Bowl (~ -149.9, 61.2)",
    sql: `SELECT count(*) FROM (
            SELECT ST_GeomFromWKB(geom_wkb) AS g FROM lake.parcels_current WHERE tax_district = '4'
          ) WHERE ST_XMin(g) < -149.3 OR ST_XMax(g) > -148.9
             OR ST_YMin(g) < 60.85 OR ST_YMax(g) > 61.05`,
  },
  {
    name: "girdwood_legal_description_undercounts",
    severity: "warn",
    description:
      "the legal-description alternative stays much worse: matching '%GIRDWOOD%' finds well under " +
      "a quarter of the service area's parcels (242 of 1,851 on 2026-07-05)",
    sql: `SELECT CASE WHEN count(*) FILTER (upper(legal_description) LIKE '%GIRDWOOD%')
                      < 0.25 * count(*) FILTER (tax_district = '4') THEN 0 ELSE 1 END
          FROM lake.parcels_current`,
  },
];

export interface CheckOutcome {
  check: Check;
  violations: number;
  /** pass = within allowance; warn = over allowance, severity 'warn'; fail = over allowance, severity 'error'. */
  status: "pass" | "warn" | "fail";
  /** Human-readable violation report; only set when status is not 'pass'. */
  detail?: string;
}

/**
 * In-memory connection with the archive attached as `lake` and the browser
 * artifact as `browser` (READ_ONLY), exactly as a reader of the published
 * files would. Both arguments accept a local path or an https:// URL.
 */
export async function openCheckConnection(
  archive: string,
  browser: string,
): Promise<{ conn: DuckDBConnection; close(): void }> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL spatial; LOAD spatial;");
  await conn.run(`ATTACH ${sqlStr(archive)} AS lake (READ_ONLY)`);
  await conn.run(`ATTACH ${sqlStr(browser)} AS browser (READ_ONLY)`);
  return {
    conn,
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

export async function runCheck(conn: DuckDBConnection, check: Check): Promise<CheckOutcome> {
  const rows = async (sql: string) => (await conn.run(sql)).getRowObjectsJson();
  const violations = Number(Object.values((await rows(check.sql))[0]!)[0]);
  const allowance = check.allowance ?? 0;
  if (violations <= allowance) return { check, violations, status: "pass" };

  const samples = check.sampleSql ? await rows(check.sampleSql) : undefined;
  const detail =
    `${check.name}: ${violations} violations (allowance ${allowance}) — ${check.description}` +
    (samples ? `\nsamples: ${JSON.stringify(samples, null, 2)}` : "");
  return { check, violations, status: check.severity === "warn" ? "warn" : "fail", detail };
}

/** Run the suite (or just the error-severity gate) and return every outcome. */
export async function runChecks(
  conn: DuckDBConnection,
  opts: { errorOnly?: boolean } = {},
): Promise<CheckOutcome[]> {
  const checks = opts.errorOnly ? CHECKS.filter((c) => c.severity === "error") : CHECKS;
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    outcomes.push(await runCheck(conn, check));
  }
  return outcomes;
}
