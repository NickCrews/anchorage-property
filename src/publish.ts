import fs from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { ARCHIVE_KEY, requireR2Config } from "./config.js";
import { logger } from "./logger.js";

function r2Endpoint(objectKey: string) {
  const r2 = requireR2Config();
  return {
    client: new AwsClient({
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      service: "s3",
      region: "auto",
    }),
    url: `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${objectKey}`,
    publicUrl: `${r2.publicUrl}/${objectKey}`,
  };
}

/**
 * Upload a local file to the bucket under objectKey. R2 object PUTs are
 * atomic per object, so readers see either the old file or the new one, never
 * a torn write. Call only after the database's session is closed, so the file
 * is checkpointed and has no WAL beside it.
 *
 * The size is logged on every run: a single PUT is appropriate for the
 * archive today (~56 MB), and this log line is how we notice it approaching
 * the point where multipart upload is warranted.
 */
export async function publishObject(localPath: string, objectKey: string): Promise<void> {
  const { client, url, publicUrl } = r2Endpoint(objectKey);
  const body = await fs.promises.readFile(localPath);
  const res = await client.fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!res.ok) {
    throw new Error(`Upload of ${objectKey} failed: HTTP ${res.status} ${await res.text()}`);
  }
  logger.info({ event: "artifact_published", objectKey, bytes: body.byteLength, publicUrl });
}

/**
 * Download the published archive from the bucket into dbPath, so that
 * ephemeral writers (CI runners) that don't persist data/db-r2/ between runs
 * continue the existing history instead of bootstrapping a fresh one. Returns
 * false when the bucket has no archive yet (very first run).
 */
export async function restoreArchive(dbPath: string): Promise<boolean> {
  const { client, url } = r2Endpoint(ARCHIVE_KEY);
  const res = await client.fetch(url, { method: "GET" });
  if (res.status === 404) {
    logger.info({ event: "archive_restore_skipped", reason: "no archive in bucket yet" });
    return false;
  }
  if (!res.ok) {
    throw new Error(`Archive download failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.promises.writeFile(dbPath, body);
  logger.info({ event: "archive_restored", bytes: body.byteLength });
  return true;
}
