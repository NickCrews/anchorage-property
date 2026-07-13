/**
 * ingest [path] — download the full MOA property layer, collapse it to one
 * row per parcel, and SCD2-merge it into the workspace's working copy (or
 * whatever path it is given). Safe to re-run: an unchanged upstream produces
 * zero new rows.
 *
 * Run sequence: fetch → merge → record run → checkpoint/close → build browser
 * artifact. Strictly local: it never touches the remote — syncing is `pull` /
 * `push`'s job, and the working copy is whatever the last pull left (or a
 * fresh database bootstrapped on first run).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, dbPaths } from "./config.js";
import { logger } from "./logger.js";
import { fetchAllParcels } from "./arcgis.js";
import { buildBrowserArtifact } from "./export.js";
import { ensureSchema, openStore } from "./store.js";
import { assertSnapshotSane, mergeSnapshot, recordRun, stageSnapshot } from "./pipeline.js";

async function main() {
  const startedAtIso = new Date().toISOString();
  const runId = `${startedAtIso.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const archive = process.argv[2]
    ? path.resolve(process.argv[2])
    : dbPaths(config.workspaceDir).archive;
  const { browser } = dbPaths(path.dirname(archive));
  // Raw pages live beside the database they feed, inside the same workspace.
  const rawRunDir = path.join(path.dirname(archive), "raw", runId);
  const log = logger.child({ runId });
  log.info({ event: "ingest_start", serviceUrl: config.serviceUrl, archive });

  const fetchResult = await fetchAllParcels({
    serviceUrl: config.serviceUrl,
    outDir: rawRunDir,
    pageSize: config.pageSize,
    concurrency: config.fetchConcurrency,
    retries: config.fetchRetries,
    timeoutMs: config.fetchTimeoutMs,
  });

  if (fetchResult.fetchedFeatures < fetchResult.serverCount * 0.99) {
    throw new Error(
      `Fetched ${fetchResult.fetchedFeatures} of ${fetchResult.serverCount} features (<99%); aborting before merge.`,
    );
  }

  const store = await openStore({ dbPath: archive, createIfMissing: true });
  try {
    await ensureSchema(store.conn);

    log.info({ event: "stage_start", pages: fetchResult.files.length });
    await stageSnapshot(store.conn, path.join(rawRunDir, "*.ndjson"));
    await assertSnapshotSane(store.conn, config.minSnapshotRatio, config.allowShrink);

    log.info({ event: "merge_start" });
    const counts = await mergeSnapshot(store.conn, startedAtIso);
    counts.sourceFeatures = fetchResult.fetchedFeatures;

    const finishedAtIso = new Date().toISOString();
    await recordRun(store.conn, {
      runId,
      startedAtIso,
      finishedAtIso,
      status: "success",
      serverCount: fetchResult.serverCount,
      ...counts,
    });
    log.info({
      event: "ingest_done",
      durationSec: Math.round((Date.parse(finishedAtIso) - Date.parse(startedAtIso)) / 1000),
      ...counts,
    });
  } finally {
    await store.close();
  }

  // A leftover WAL means the checkpoint didn't happen; deriving the browser
  // artifact from (or later pushing) the bare .duckdb would hand readers a
  // torn database.
  if (fs.existsSync(`${archive}.wal`)) {
    throw new Error(`${archive}.wal still exists after close; refusing to build from a torn archive.`);
  }
  log.info({ event: "archive_size", bytes: (await fs.promises.stat(archive)).size });

  await buildBrowserArtifact(archive, browser);

  if (!config.keepRaw) {
    await fs.promises.rm(rawRunDir, { recursive: true, force: true });
    log.info({ event: "raw_cleaned", rawRunDir });
  }
}

main().catch((err) => {
  logger.error({ event: "ingest_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
