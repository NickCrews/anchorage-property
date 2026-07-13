import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env once, here, for every entry point. Real environment variables win
// over the file (Node's documented precedence), so CI's env: block and ad-hoc
// `WORKSPACE=exp pnpm ...` overrides behave as expected.
const envFile = path.join(projectRoot, ".env");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

if (process.env.DB_TARGET !== undefined) {
  throw new Error(
    "DB_TARGET has been replaced by workspaces — remove it and (optionally) set " +
      "WORKSPACE instead. See CONTRIBUTING.md: the lifecycle is now pull / ingest / verify / push.",
  );
}

/**
 * Which local workspace the verbs operate on. A workspace is a directory
 * `workspaces/<name>/` holding one working copy of the archive together with
 * everything that belongs to it: the browser artifact, the ETag sidecar
 * recording which remote object it descends from, and per-run raw downloads.
 *
 * The name is just a label for a local context ("default", "r2", a throwaway
 * experiment) — whether a push/pull is possible is decided by the R2_*
 * credentials, and whether it is safe is decided by the lineage guards
 * (pull's unrelated-history refusal, push's compare-and-swap), not by the
 * workspace's name.
 */
const workspace = process.env.WORKSPACE ?? "default";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace) || workspace.includes("..")) {
  throw new Error(
    `WORKSPACE must be a simple directory name (letters, digits, . _ -), got "${workspace}".`,
  );
}

/** Published object keys — also the local file names inside a workspace. */
export const ARCHIVE_KEY = "anchorage.duckdb";
export const BROWSER_KEY = "anchorage-current.duckdb";

/**
 * Public base URL of the canonical published dataset. This is where readers —
 * and the test suites' defaults — find the data. (R2_PUBLIC_URL in config.r2
 * is different: it is where *this writer's* bucket is served, for anyone
 * publishing their own copy.)
 */
export const PUBLIC_BASE_URL = "https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev";
export const PUBLIC_ARCHIVE_URL = `${PUBLIC_BASE_URL}/${ARCHIVE_KEY}`;
export const PUBLIC_BROWSER_URL = `${PUBLIC_BASE_URL}/${BROWSER_KEY}`;

export const config = {
  projectRoot,

  workspace,

  /** ArcGIS FeatureServer layer: MOA parcel boundaries merged with Property Appraisal CAMA data. */
  serviceUrl:
    process.env.MOA_SERVICE_URL ??
    "https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0",

  /** The selected workspace's directory — the default target of every verb. */
  workspaceDir: path.join(projectRoot, "workspaces", workspace),

  r2: {
    bucket: process.env.R2_BUCKET ?? "",
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    /** Public https base URL serving the bucket (r2.dev subdomain or custom domain), no trailing slash. */
    publicUrl: (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, ""),
  },

  /** Keep the per-run raw NDJSON downloads instead of deleting them after a successful run. */
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

export function dbPaths(dir: string) {
  return {
    archive: path.join(dir, ARCHIVE_KEY),
    browser: path.join(dir, BROWSER_KEY),
  };
}

/**
 * Sidecar file remembering the remote archive's ETag as of the last pull (or
 * push) — the lineage marker tying a working copy to the remote object it
 * descends from. `push` sends it as If-Match so a stale copy cannot silently
 * clobber remote history; `pull` treats its absence beside an existing
 * archive as "locally-born database" and refuses to overwrite it.
 */
export function etagPath(archivePath: string) {
  return `${archivePath}.etag`;
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
      `No remote configured: pull/push need ${missing.join(", ")} — ` +
        `copy .env.example to .env and fill it in. Every other command works without a remote.`,
    );
  }
  return config.r2;
}
