/**
 * pull [path] [--force] — remote archive → the workspace's working copy,
 * recording the source ETag in a sidecar file. `push` later sends that ETag
 * as If-Match, so a working copy that has gone stale since this pull cannot
 * silently clobber remote history.
 *
 * The mirror-image guard runs here: an existing archive with *no* ETag
 * sidecar is a locally-born database whose history was never the remote's
 * (git would call these unrelated histories), so pulling over it would
 * destroy local history. pull refuses unless --force.
 *
 * Never writes to the remote.
 */
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_KEY, config, dbPaths, etagPath } from "./config.js";
import { logger } from "./logger.js";
import { fetchObject } from "./publish.js";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const pathArg = args.find((a) => a !== "--force");
  const archive = pathArg ? path.resolve(pathArg) : dbPaths(config.workspaceDir).archive;

  if (!force && fs.existsSync(archive) && !fs.existsSync(etagPath(archive))) {
    throw new Error(
      `${archive} exists but has no recorded ETag: it is a locally-born database, ` +
        `not a copy of the remote, and pulling would overwrite its history. ` +
        `Move it aside, use another WORKSPACE, or --force to overwrite.`,
    );
  }

  const etag = await fetchObject(ARCHIVE_KEY, archive);
  if (etag === null) {
    // Empty bucket: nothing to pull. Leave no stale sidecar around — the
    // first push will use If-None-Match: * (create-if-absent) instead.
    await fs.promises.rm(etagPath(archive), { force: true });
    logger.info({ event: "pull_skipped", reason: "no archive in bucket yet", archive });
    return;
  }
  await fs.promises.writeFile(etagPath(archive), etag);
  logger.info({ event: "pull_done", archive, etag });
}

main().catch((err) => {
  logger.error({ event: "pull_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
