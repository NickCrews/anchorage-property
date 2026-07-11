import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which database the commands operate on:
 *   local (default) — .duckdb files under data/db, nothing leaves the machine,
 *                     no credentials needed.
 *   r2              — .duckdb files under data/db-r2, restored from and
 *                     published to the R2 bucket after each ingest. Requires
 *                     the R2_* variables below (npm scripts load them from .env).
 */
const dbTarget = (process.env.DB_TARGET ?? "local") as "local" | "r2";

/** Published object keys — also the local file names under dbDir. */
export const ARCHIVE_KEY = "anchorage.duckdb";
export const BROWSER_KEY = "anchorage-current.duckdb";

export const config = {
  projectRoot,

  dbTarget,

  /** ArcGIS FeatureServer layer: MOA parcel boundaries merged with Property Appraisal CAMA data. */
  serviceUrl:
    process.env.MOA_SERVICE_URL ??
    "https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0",

  /** Directory holding the archive and browser .duckdb files. */
  dbDir: process.env.DB_DIR ?? path.join(projectRoot, "data", dbTarget === "r2" ? "db-r2" : "db"),

  r2: {
    bucket: process.env.R2_BUCKET ?? "",
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    /** Public https base URL serving the bucket (r2.dev subdomain or custom domain), no trailing slash. */
    publicUrl: (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, ""),
  },

  /** Directory for raw per-run NDJSON downloads (deleted after a successful run unless KEEP_RAW=1). */
  rawDir: process.env.RAW_DIR ?? path.join(projectRoot, "data", "raw"),

  keepRaw: process.env.KEEP_RAW === "1",

  pageSize: Number(process.env.PAGE_SIZE ?? 2000),
  fetchConcurrency: Number(process.env.FETCH_CONCURRENCY ?? 4),
  fetchRetries: Number(process.env.FETCH_RETRIES ?? 5),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 180_000),

  /**
   * Safety gate: abort (leaving history untouched) if the fresh snapshot has fewer
   * distinct parcels than this fraction of the current archive count. Protects the
   * history trail from a partially-broken upstream export. Override with ALLOW_SHRINK=1.
   */
  minSnapshotRatio: Number(process.env.MIN_SNAPSHOT_RATIO ?? 0.95),
  allowShrink: process.env.ALLOW_SHRINK === "1",
};

export function dbPaths(dbDir: string) {
  return {
    archive: path.join(dbDir, ARCHIVE_KEY),
    browser: path.join(dbDir, BROWSER_KEY),
  };
}

export interface R2Config {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
}

export function requireR2Config(): R2Config {
  const missing = Object.entries(config.r2)
    .filter(([, v]) => v === "")
    .map(([k]) => `R2_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
  if (missing.length > 0) {
    throw new Error(
      `DB_TARGET=r2 requires ${missing.join(", ")} — copy .env.example to .env and fill it in.`,
    );
  }
  return config.r2;
}
