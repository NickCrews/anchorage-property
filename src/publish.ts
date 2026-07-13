import fs from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { requireR2Config } from "./config.js";
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
 * The compare-and-swap precondition for an upload.
 *   { ifMatch: etag }  — replace only the exact object version we pulled;
 *                        anything else fails with 412 instead of clobbering.
 *   "create"           — If-None-Match: *; succeed only if the object does
 *                        not exist yet (very first push to an empty bucket).
 *   "overwrite"        — no precondition (--force, and pure derivatives like
 *                        the browser artifact).
 */
export type PutPrecondition = { ifMatch: string } | "create" | "overwrite";

/** Thrown when the remote moved out from under us (HTTP 412). */
export class PreconditionFailedError extends Error {
  constructor(objectKey: string) {
    super(`Upload of ${objectKey} failed: HTTP 412 Precondition Failed`);
    this.name = "PreconditionFailedError";
  }
}

/**
 * Upload a local file to the bucket under objectKey, guarded by the given
 * precondition (R2 honors If-Match / If-None-Match on PUT — verified against
 * the live bucket 2026-07-10). Returns the new object's ETag so the caller
 * can record it as the baseline for the next push.
 *
 * R2 object PUTs are atomic per object, so readers see either the old file or
 * the new one, never a torn write. Call only after the database's session is
 * closed, so the file is checkpointed and has no WAL beside it.
 *
 * The size is logged on every run: a single PUT is appropriate for the
 * archive today (~56 MB), and this log line is how we notice it approaching
 * the point where multipart upload is warranted.
 */
export async function publishObject(
  localPath: string,
  objectKey: string,
  precondition: PutPrecondition,
): Promise<string> {
  const { client, url, publicUrl } = r2Endpoint(objectKey);
  const body = await fs.promises.readFile(localPath);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (precondition === "create") headers["If-None-Match"] = "*";
  else if (precondition !== "overwrite") headers["If-Match"] = precondition.ifMatch;

  const res = await client.fetch(url, { method: "PUT", body, headers });
  if (res.status === 412) {
    throw new PreconditionFailedError(objectKey);
  }
  if (!res.ok) {
    throw new Error(`Upload of ${objectKey} failed: HTTP ${res.status} ${await res.text()}`);
  }
  let etag = res.headers.get("etag");
  if (!etag) {
    // Defensive: R2 returns the ETag on PUT, but fall back to HEAD if not.
    const head = await client.fetch(url, { method: "HEAD" });
    etag = head.headers.get("etag") ?? "";
  }
  logger.info({ event: "artifact_published", objectKey, bytes: body.byteLength, etag, publicUrl });
  return etag;
}

/**
 * Download an object from the bucket into localPath and return its ETag, or
 * null when the bucket has no such object yet (very first run against an
 * empty bucket).
 */
export async function fetchObject(objectKey: string, localPath: string): Promise<string | null> {
  const { client, url } = r2Endpoint(objectKey);
  const res = await client.fetch(url, { method: "GET" });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Download of ${objectKey} failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fs.promises.writeFile(localPath, body);
  const etag = res.headers.get("etag") ?? "";
  logger.info({ event: "object_fetched", objectKey, bytes: body.byteLength, etag });
  return etag;
}
