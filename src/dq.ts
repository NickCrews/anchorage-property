import { DuckDBConnection } from "@duckdb/node-api";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { openLake, rowObjects, scalar } from "./lake.js";

/**
 * Data-quality suite over the production lake. Each check's SQL returns the
 * number of VIOLATING rows; the check passes when that count is <= allowance.
 *
 * severity 'error'  → known-impossible states; any failure exits non-zero.
 * severity 'warn'   → real-world dirtiness we tolerate up to an allowance
 *                     (e.g. a couple of genuine ~1 m² sliver parcels and a
 *                     handful of OGC-invalid rings in the source).
 */
interface Check {
  name: string;
  severity: "error" | "warn";
  description: string;
  sql: string;
  allowance?: number;
  /** SQL returning up to 5 sample offending rows, for the log. */
  sampleSql?: string;
}

const CHECKS: Check[] = [
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
    description: "land + building ≈ total appraised value",
    sql: `SELECT count(*) FROM lake.parcels_current
          WHERE appraised_total_value IS NOT NULL
            AND abs(coalesce(appraised_land_value, 0) + coalesce(appraised_building_value, 0)
                    - appraised_total_value) > 1`,
    allowance: 100,
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
];

async function runCheck(conn: DuckDBConnection, check: Check) {
  const started = Date.now();
  const violations = Number(await scalar(conn, check.sql));
  const allowance = check.allowance ?? 0;
  const passed = violations <= allowance;
  const result = {
    event: "dq_check",
    check: check.name,
    severity: check.severity,
    passed,
    violations,
    allowance,
    ms: Date.now() - started,
  };
  if (passed) {
    logger.info(result);
  } else {
    const samples = check.sampleSql ? await rowObjects(conn, check.sampleSql) : undefined;
    const level = check.severity === "error" ? "error" : "warn";
    logger[level]({ ...result, description: check.description, samples });
  }
  return { ...check, passed, violations };
}

async function main() {
  logger.info({ event: "dq_start", lakeDir: config.lakeDir, checks: CHECKS.length });
  const lake = await openLake(config.lakeDir);
  try {
    const stats = await rowObjects(
      lake.conn,
      `SELECT (SELECT count(*) FROM lake.parcels_current)                          AS current_parcels,
              (SELECT count(*) FROM lake.parcels)                                  AS version_rows,
              (SELECT count(DISTINCT owner_name) FROM lake.parcels_current)        AS distinct_owners,
              (SELECT max(finished_at) FROM lake.ingest_runs WHERE status='success') AS last_success`,
    );
    logger.info({ event: "dq_lake_stats", ...stats[0] });

    const results = [];
    for (const check of CHECKS) results.push(await runCheck(lake.conn, check));

    const failedErrors = results.filter((r) => !r.passed && r.severity === "error");
    const failedWarns = results.filter((r) => !r.passed && r.severity === "warn");
    logger.info({
      event: "dq_done",
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failedErrors: failedErrors.map((r) => r.name),
      failedWarns: failedWarns.map((r) => r.name),
    });
    if (failedErrors.length > 0) process.exitCode = 1;
  } finally {
    await lake.close();
  }
}

main().catch((err) => {
  logger.error({ event: "dq_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
