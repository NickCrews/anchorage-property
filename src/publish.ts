import fs from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { requireR2Config } from "./config.js";
import { logger } from "./logger.js";

function catalogEndpoint() {
  const r2 = requireR2Config();
  return {
    client: new AwsClient({
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      service: "s3",
      region: "auto",
    }),
    url: `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/catalog.ducklake`,
  };
}

/**
 * Upload the local catalog file to the bucket as `catalog.ducklake`. This is
 * the publish step: parquet files were already written to the bucket during
 * the merge, but readers only see the new snapshot once the catalog that
 * references it lands. Call after the lake session is closed, so the file is
 * checkpointed and has no pending WAL.
 */
export async function publishCatalog(catalogPath: string): Promise<void> {
  const r2 = requireR2Config();
  const { client, url } = catalogEndpoint();
  const body = await fs.promises.readFile(catalogPath);
  const res = await client.fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!res.ok) {
    throw new Error(`Catalog upload failed: HTTP ${res.status} ${await res.text()}`);
  }
  logger.info({
    event: "catalog_published",
    bytes: body.byteLength,
    publicUrl: `${r2.publicUrl}/catalog.ducklake`,
  });
}

/**
 * Download the published catalog from the bucket into catalogPath, so that
 * ephemeral writers (CI runners) that don't persist data/lake-r2/ between runs
 * continue the existing lake instead of bootstrapping a fresh one. Returns
 * false when the bucket has no catalog yet (very first run).
 */
export async function restoreCatalog(catalogPath: string): Promise<boolean> {
  const { client, url } = catalogEndpoint();
  const res = await client.fetch(url, { method: "GET" });
  if (res.status === 404) {
    logger.info({ event: "catalog_restore_skipped", reason: "no catalog in bucket yet" });
    return false;
  }
  if (!res.ok) {
    throw new Error(`Catalog download failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.promises.writeFile(catalogPath, body);
  logger.info({ event: "catalog_restored", bytes: body.byteLength });
  return true;
}
