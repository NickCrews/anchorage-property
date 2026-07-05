import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  projectRoot,

  /** ArcGIS FeatureServer layer: MOA parcel boundaries merged with Property Appraisal CAMA data. */
  serviceUrl:
    process.env.MOA_SERVICE_URL ??
    "https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0",

  /** Directory holding the DuckLake catalog + parquet data files. */
  lakeDir: process.env.LAKE_DIR ?? path.join(projectRoot, "data", "lake"),

  /** Directory for raw per-run NDJSON downloads (deleted after a successful run unless KEEP_RAW=1). */
  rawDir: process.env.RAW_DIR ?? path.join(projectRoot, "data", "raw"),

  keepRaw: process.env.KEEP_RAW === "1",

  pageSize: Number(process.env.PAGE_SIZE ?? 2000),
  fetchConcurrency: Number(process.env.FETCH_CONCURRENCY ?? 4),
  fetchRetries: Number(process.env.FETCH_RETRIES ?? 5),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 180_000),

  /**
   * Safety gate: abort (leaving history untouched) if the fresh snapshot has fewer
   * distinct parcels than this fraction of the current lake count. Protects the
   * history trail from a partially-broken upstream export. Override with ALLOW_SHRINK=1.
   */
  minSnapshotRatio: Number(process.env.MIN_SNAPSHOT_RATIO ?? 0.95),
  allowShrink: process.env.ALLOW_SHRINK === "1",
};

export function lakePaths(lakeDir: string) {
  return {
    catalog: path.join(lakeDir, "catalog.ducklake"),
    dataPath: path.join(lakeDir, "parquet"),
  };
}
