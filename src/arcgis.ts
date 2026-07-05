import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "./logger.js";
import { OUT_FIELDS } from "./fields.js";

interface GeoJsonFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: unknown;
}

export interface FetchResult {
  /** NDJSON files written (one per page). */
  files: string[];
  serverCount: number;
  fetchedFeatures: number;
}

export interface FetchOptions {
  serviceUrl: string;
  outDir: string;
  pageSize: number;
  concurrency: number;
  retries: number;
  timeoutMs: number;
}

async function getJson(url: string, retries: number, timeoutMs: number): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      // ArcGIS reports many failures as HTTP 200 with an error payload.
      if (body && typeof body === "object" && "error" in body) {
        throw new Error(`ArcGIS error: ${JSON.stringify((body as any).error)}`);
      }
      return body;
    } catch (err) {
      lastError = err;
      const backoffMs = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      logger.warn({ event: "fetch_retry", attempt, retries, backoffMs, err: String(err) });
      if (attempt < retries) await sleep(backoffMs);
    }
  }
  throw new Error(`Fetch failed after ${retries} attempts: ${String(lastError)}`);
}

export async function fetchServerCount(opts: FetchOptions): Promise<number> {
  const url = `${opts.serviceUrl}/query?where=1%3D1&returnCountOnly=true&f=json`;
  const body = await getJson(url, opts.retries, opts.timeoutMs);
  return Number(body.count);
}

function pageUrl(opts: FetchOptions, offset: number): string {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: OUT_FIELDS.join(","),
    orderByFields: "OBJECTID ASC",
    resultOffset: String(offset),
    resultRecordCount: String(opts.pageSize),
    outSR: "4326",
    f: "geojson",
  });
  return `${opts.serviceUrl}/query?${params.toString()}`;
}

/**
 * Fetch one page and write it as NDJSON: one line per feature,
 * {...properties, __geometry: "<geojson geometry string>"}.
 * Returns the number of features on the page.
 */
async function fetchPage(opts: FetchOptions, pageIndex: number, offset: number): Promise<{ file: string | null; count: number }> {
  const body = await getJson(pageUrl(opts, offset), opts.retries, opts.timeoutMs);
  const features: GeoJsonFeature[] = body.features ?? [];
  if (features.length === 0) return { file: null, count: 0 };

  const lines = features.map((f) =>
    JSON.stringify({ ...f.properties, __geometry: f.geometry == null ? null : JSON.stringify(f.geometry) }),
  );
  const file = path.join(opts.outDir, `page-${String(pageIndex).padStart(5, "0")}.ndjson`);
  await fs.promises.writeFile(file, lines.join("\n") + "\n");
  logger.debug({ event: "page_fetched", pageIndex, offset, features: features.length });
  return { file, count: features.length };
}

/**
 * Download the full layer with offset pagination, `concurrency` pages in flight.
 * Pages are fixed-size windows ordered by OBJECTID; the loop extends until a
 * page comes back empty (the server count is only used for logging/validation).
 */
export async function fetchAllParcels(opts: FetchOptions): Promise<FetchResult> {
  await fs.promises.mkdir(opts.outDir, { recursive: true });
  const serverCount = await fetchServerCount(opts);
  const expectedPages = Math.ceil(serverCount / opts.pageSize);
  logger.info({ event: "fetch_start", serverCount, pageSize: opts.pageSize, expectedPages });

  const files: string[] = [];
  let fetchedFeatures = 0;
  let nextPage = 0;
  let sawEnd = false;

  async function worker(workerId: number) {
    while (!sawEnd) {
      const pageIndex = nextPage++;
      const { file, count } = await fetchPage(opts, pageIndex, pageIndex * opts.pageSize);
      if (file) files.push(file);
      fetchedFeatures += count;
      if (count < opts.pageSize) sawEnd = true; // short or empty page ⇒ past the end
      if (pageIndex > 0 && pageIndex % 10 === 0) {
        logger.info({ event: "fetch_progress", workerId, pagesDone: pageIndex, fetchedFeatures });
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(i)));
  logger.info({ event: "fetch_done", serverCount, fetchedFeatures, pages: files.length });
  return { files, serverCount, fetchedFeatures };
}
