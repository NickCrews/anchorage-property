import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { fetchAllParcels } from "./arcgis.js";
import { ensureSchema, openLake } from "./lake.js";
import { assertSnapshotSane, mergeSnapshot, recordRun, stageSnapshot } from "./pipeline.js";

/**
 * Daily ingest: download the full MOA property layer, collapse it to one row
 * per parcel, and SCD2-merge it into the DuckLake. Safe to re-run: an
 * unchanged upstream produces zero new rows.
 */
async function main() {
  const startedAtIso = new Date().toISOString();
  const runId = `${startedAtIso.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const rawRunDir = path.join(config.rawDir, runId);
  const log = logger.child({ runId });
  log.info({ event: "ingest_start", serviceUrl: config.serviceUrl, lakeDir: config.lakeDir });

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

  const lake = await openLake(config.lakeDir);
  try {
    await ensureSchema(lake.conn);

    log.info({ event: "stage_start", pages: fetchResult.files.length });
    await stageSnapshot(lake.conn, path.join(rawRunDir, "*.ndjson"));
    await assertSnapshotSane(lake.conn, config.minSnapshotRatio, config.allowShrink);

    log.info({ event: "merge_start" });
    const counts = await mergeSnapshot(lake.conn, startedAtIso);
    counts.sourceFeatures = fetchResult.fetchedFeatures;

    const finishedAtIso = new Date().toISOString();
    await recordRun(lake.conn, {
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
    await lake.close();
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
