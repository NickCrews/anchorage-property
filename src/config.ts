import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which lake the commands operate on:
 *   local (default) — catalog + parquet under data/lake, nothing leaves the machine.
 *   r2              — catalog under data/lake-r2 (mirrored to the bucket after each
 *                     ingest), parquet written directly to the R2 bucket. Requires
 *                     the R2_* variables below (npm scripts load them from .env).
 */
const lakeTarget = (process.env.LAKE_TARGET ?? "local") as "local" | "r2";

export const config = {
  projectRoot,

  lakeTarget,

  /** ArcGIS FeatureServer layer: MOA parcel boundaries merged with Property Appraisal CAMA data. */
  serviceUrl:
    process.env.MOA_SERVICE_URL ??
    "https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0",

  /** Directory holding the DuckLake catalog (+ parquet data files for the local target). */
  lakeDir:
    process.env.LAKE_DIR ?? path.join(projectRoot, "data", lakeTarget === "r2" ? "lake-r2" : "lake"),

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
      `LAKE_TARGET=r2 requires ${missing.join(", ")} — copy .env.example to .env and fill it in.`,
    );
  }
  return config.r2;
}

/** Where the lake's parquet data lives, independent of where the catalog file is. */
export type LakeData =
  | { kind: "local"; dir: string }
  | { kind: "r2"; r2: R2Config };

export interface OpenLakeOptions {
  /** Local filesystem path of the catalog.ducklake file. */
  catalog: string;
  data: LakeData;
  /**
   * Permit bootstrapping a brand-new catalog when `catalog` does not exist.
   * Only consulted for the r2 data target: there a missing catalog throws by
   * default, so a runner that skipped restoreCatalog() fails loudly instead of
   * silently forking the published lake. Local lakes are created on demand.
   */
  createIfMissing?: boolean;
}

/** The lake selected by LAKE_TARGET / LAKE_DIR, as concrete openLake() options. */
export function resolveLakeOptions(): OpenLakeOptions {
  const { catalog, dataPath } = lakePaths(config.lakeDir);
  return {
    catalog,
    data:
      config.lakeTarget === "r2"
        ? { kind: "r2", r2: requireR2Config() }
        : { kind: "local", dir: dataPath },
  };
}
