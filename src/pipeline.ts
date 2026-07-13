import { DuckDBConnection } from "@duckdb/node-api";
import { aggregatedFieldSql, attrHashSql, lakeColumnNames, stagingColumnsSql } from "./fields.js";
import { logger } from "./logger.js";
import { sqlStr } from "./quote.js";
import { scalar } from "./store.js";

export interface MergeCounts {
  sourceFeatures: number;
  distinctParcels: number;
  newParcels: number;
  changedParcels: number;
  retiredParcels: number;
  unchangedParcels: number;
}

/**
 * Read raw NDJSON pages and collapse them into a one-row-per-parcel snapshot
 * temp table. Multi-part parcels (Parcel_ID_Count > 1) have their polygons
 * unioned into a single geometry; attributes are identical across the parts so
 * the first card's values are taken.
 *
 * Geometry is kept as WKB in EPSG:4326; area_m2 is computed in EPSG:3338
 * (Alaska Albers, meters) — Web-Mercator areas are ~4x inflated at 61°N.
 */
export async function stageSnapshot(conn: DuckDBConnection, ndjsonGlob: string): Promise<void> {
  // The source contains ~1k features with an empty Parcel_ID and all-null
  // attributes (uncatalogued geometry slivers, no CAMA record). They cannot be
  // keyed, so they are dropped — count them so the log shows it.
  const dropped = Number(
    await scalar(
      conn,
      `SELECT count(*) FROM read_json(${sqlStr(ndjsonGlob)}, format = 'newline_delimited',
         columns = {'Parcel_ID': 'VARCHAR'})
       WHERE "Parcel_ID" IS NULL OR "Parcel_ID" = ''`,
    ),
  );
  logger.info({ event: "stage_dropped_unkeyed", droppedFeatures: dropped });

  await conn.run(`
    CREATE OR REPLACE TEMP TABLE snapshot AS
    WITH raw AS (
      SELECT * FROM read_json(
        ${sqlStr(ndjsonGlob)},
        format = 'newline_delimited',
        columns = ${stagingColumnsSql()}
      )
    ),
    grouped AS (
      SELECT
        "Parcel_ID" AS parcel_id,
        ${aggregatedFieldSql()},
        count(*)::INTEGER AS feature_count,
        ST_Union_Agg(ST_GeomFromGeoJSON(__geometry)) FILTER (WHERE __geometry IS NOT NULL) AS geom
      FROM raw
      WHERE "Parcel_ID" IS NOT NULL AND "Parcel_ID" <> ''
      GROUP BY "Parcel_ID"
    ),
    shaped AS (
      SELECT
        * EXCLUDE (geom),
        CASE WHEN geom IS NULL THEN NULL ELSE ST_AsWKB(geom)::BLOB END AS geom_wkb,
        CASE WHEN geom IS NULL THEN NULL
             ELSE ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:3338', always_xy := true))
        END AS area_m2
      FROM grouped
    )
    SELECT *, ${attrHashSql("coalesce(geom_wkb, ''::BLOB)")} AS attr_hash
    FROM shaped
  `);
}

/**
 * SCD2 merge of the snapshot into parcels, all inside one transaction:
 *   1. close current versions whose content hash changed
 *   2. close current versions missing from the snapshot (retired parcels)
 *   3. insert a fresh current version for every new or changed parcel
 */
export async function mergeSnapshot(conn: DuckDBConnection, runTsIso: string): Promise<MergeCounts> {
  const ts = `TIMESTAMP ${sqlStr(runTsIso.replace("T", " ").replace("Z", ""))}`;
  const cols = ["parcel_id", ...lakeColumnNames(), "feature_count", "geom_wkb", "area_m2", "attr_hash"];
  const colList = cols.map((c) => `"${c}"`).join(", ");

  const distinctParcels = Number(await scalar(conn, `SELECT count(*) FROM snapshot`));
  const newParcels = Number(
    await scalar(
      conn,
      `SELECT count(*) FROM snapshot s
       WHERE NOT EXISTS (SELECT 1 FROM parcels p WHERE p.is_current AND p.parcel_id = s.parcel_id)`,
    ),
  );
  const changedParcels = Number(
    await scalar(
      conn,
      `SELECT count(*) FROM snapshot s
       JOIN parcels p ON p.is_current AND p.parcel_id = s.parcel_id
       WHERE p.attr_hash <> s.attr_hash`,
    ),
  );
  const retiredParcels = Number(
    await scalar(
      conn,
      `SELECT count(*) FROM parcels p
       WHERE p.is_current AND NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.parcel_id = p.parcel_id)`,
    ),
  );
  const unchangedParcels = distinctParcels - newParcels - changedParcels;

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`
      UPDATE parcels p SET valid_to = ${ts}, is_current = false
      WHERE p.is_current AND EXISTS (
        SELECT 1 FROM snapshot s WHERE s.parcel_id = p.parcel_id AND s.attr_hash <> p.attr_hash
      )
    `);
    await conn.run(`
      UPDATE parcels p SET valid_to = ${ts}, is_current = false
      WHERE p.is_current AND NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.parcel_id = p.parcel_id)
    `);
    await conn.run(`
      INSERT INTO parcels (${colList}, valid_from, valid_to, is_current)
      SELECT ${colList}, ${ts}, NULL, true
      FROM snapshot s
      WHERE NOT EXISTS (SELECT 1 FROM parcels p WHERE p.is_current AND p.parcel_id = s.parcel_id)
    `);
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  }

  return { sourceFeatures: 0, distinctParcels, newParcels, changedParcels, retiredParcels, unchangedParcels };
}

export interface RunRecord extends MergeCounts {
  runId: string;
  startedAtIso: string;
  finishedAtIso: string;
  status: string;
  serverCount: number;
}

export async function recordRun(conn: DuckDBConnection, r: RunRecord): Promise<void> {
  const t = (iso: string) => `TIMESTAMP ${sqlStr(iso.replace("T", " ").replace("Z", ""))}`;
  await conn.run(`
    INSERT INTO ingest_runs VALUES (
      ${sqlStr(r.runId)}, ${t(r.startedAtIso)}, ${t(r.finishedAtIso)}, ${sqlStr(r.status)},
      ${r.serverCount}, ${r.sourceFeatures}, ${r.distinctParcels},
      ${r.newParcels}, ${r.changedParcels}, ${r.retiredParcels}, ${r.unchangedParcels}
    )
  `);
}

/**
 * Abort-before-merge gate: refuse to apply a snapshot that is drastically
 * smaller than the current archive — that smells like a broken upstream export,
 * and applying it would spuriously "retire" thousands of parcels.
 */
export async function assertSnapshotSane(
  conn: DuckDBConnection,
  minRatio: number,
  allowShrink: boolean,
): Promise<void> {
  const current = Number(await scalar(conn, `SELECT count(*) FROM parcels WHERE is_current`));
  const snapshot = Number(await scalar(conn, `SELECT count(*) FROM snapshot`));
  if (current > 0 && snapshot < current * minRatio && !allowShrink) {
    throw new Error(
      `Snapshot has ${snapshot} parcels but archive has ${current} current parcels ` +
        `(< ${minRatio} ratio). Refusing to merge; set ALLOW_SHRINK=1 to override.`,
    );
  }
  logger.info({ event: "snapshot_sane", currentParcels: current, snapshotParcels: snapshot });
}
