import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ARCHIVE_KEY, BROWSER_KEY, config, dbPaths } from "./config.js";
import { logger } from "./logger.js";
import { fetchAllParcels } from "./arcgis.js";
import { buildBrowserArtifact } from "./export.js";
import { ensureSchema, openStore } from "./store.js";
import { assertSnapshotSane, mergeSnapshot, recordRun, stageSnapshot } from "./pipeline.js";
import { publishObject, restoreArchive } from "./publish.js";

/**
 * Daily ingest: download the full MOA property layer, collapse it to one row
 * per parcel, and SCD2-merge it into the archive database. Safe to re-run: an
 * unchanged upstream produces zero new rows.
 *
 * Run sequence: fetch → restore archive → merge → record run →
 * checkpoint/close → build browser artifact → publish both. Publishing
 * happens only after the archive is closed and checkpointed, so readers never
 * see a torn file.
 */
async function main() {
  const startedAtIso = new Date().toISOString();
  const runId = `${startedAtIso.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const rawRunDir = path.join(config.rawDir, runId);
  const log = logger.child({ runId });
  log.info({
    event: "ingest_start",
    serviceUrl: config.serviceUrl,
    dbDir: config.dbDir,
    dbTarget: config.dbTarget,
  });

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

  const { archive, browser } = dbPaths(config.dbDir);
  // Ephemeral runners start without data/db-r2/: continue the published
  // history rather than forking a fresh one. createIfMissing covers the very
  // first run, when the bucket has no archive either (restoreArchive returns
  // false).
  if (config.dbTarget === "r2" && !fs.existsSync(archive)) {
    await restoreArchive(archive);
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

  // A leftover WAL means the checkpoint didn't happen; publishing the bare
  // .duckdb would hand readers a torn database.
  if (fs.existsSync(`${archive}.wal`)) {
    throw new Error(`${archive}.wal still exists after close; refusing to publish a torn archive.`);
  }
  log.info({ event: "archive_size", bytes: (await fs.promises.stat(archive)).size });

  await buildBrowserArtifact(archive, browser);

  if (config.dbTarget === "r2") {
    await publishObject(archive, ARCHIVE_KEY);
    await publishObject(browser, BROWSER_KEY);
  }

  if (!config.keepRaw) {
    await fs.promises.rm(rawRunDir, { recursive: true, force: true });
    log.info({ event: "raw_cleaned", rawRunDir });
  }
}

main().catch((err) => {
  logger.error({ event: "ingest_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
