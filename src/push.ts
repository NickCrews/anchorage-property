/**
 * push [path] [--force] — working copy → remote, guarded twice:
 *
 * 1. Self-gating: the error-severity checks run in-process against the exact
 *    files about to be uploaded, and any failure refuses the push. The gate
 *    belongs to the dangerous verb, so no script ordering can forget it.
 *    (`audit` runs the full suite, warns included, from the CLI.)
 * 2. Compare-and-swap: the archive PUT sends If-Match with the ETag recorded
 *    by the last pull (If-None-Match: * when there is none — create-if-absent
 *    for an empty bucket). If the remote moved since the pull, the push fails
 *    with 412 instead of silently clobbering remote history.
 *
 * --force skips both guards (unconditional upload, no checks) — the escape
 * hatch for adopting an existing remote object without a pulled baseline, or
 * for knowingly shipping a copy the checks reject.
 *
 * The browser artifact is published after the archive with no precondition:
 * it is a pure derivative, and the two objects are documented as allowed to
 * disagree briefly mid-refresh.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ARCHIVE_KEY,
  BROWSER_KEY,
  config,
  dbPaths,
  etagPath,
  requireR2Config,
} from "./config.js";
import { logger } from "./logger.js";
import { openCheckConnection, runChecks } from "./checks.js";
import { PreconditionFailedError, publishObject, type PutPrecondition } from "./publish.js";

async function main() {
  requireR2Config(); // fail on a missing remote before spending time on checks
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const pathArg = args.find((a) => a !== "--force");
  const archive = pathArg ? path.resolve(pathArg) : dbPaths(config.workspaceDir).archive;
  const { browser } = dbPaths(path.dirname(archive));

  if (!fs.existsSync(archive)) {
    throw new Error(`No archive at ${archive} — run \`pnpm ingest\` first.`);
  }
  if (fs.existsSync(`${archive}.wal`)) {
    throw new Error(`${archive}.wal exists; refusing to push a torn archive.`);
  }
  if (!fs.existsSync(browser)) {
    throw new Error(`No browser artifact at ${browser} — run \`pnpm ingest\` to build it.`);
  }

  if (force) {
    logger.warn({ event: "push_forced", detail: "skipping checks and ETag precondition" });
  } else {
    const db = await openCheckConnection(archive, browser);
    try {
      const failures = (await runChecks(db.conn, { errorOnly: true })).filter(
        (o) => o.status === "fail",
      );
      for (const f of failures) logger.error({ event: "check_failed", detail: f.detail });
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} error-severity check(s) failed; refusing to push. ` +
            `(--force to override.)`,
        );
      }
      logger.info({ event: "push_checks_passed" });
    } finally {
      db.close();
    }
  }

  const baseline = fs.existsSync(etagPath(archive))
    ? (await fs.promises.readFile(etagPath(archive), "utf8")).trim()
    : null;
  const precondition: PutPrecondition = force
    ? "overwrite"
    : baseline
      ? { ifMatch: baseline }
      : "create";

  let newEtag: string;
  try {
    newEtag = await publishObject(archive, ARCHIVE_KEY, precondition);
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      throw new Error(
        baseline
          ? `Remote archive changed since your last pull (If-Match ${baseline} failed). ` +
            `Your working copy is stale: \`pnpm pull\` and re-ingest, or --force to clobber.`
          : `Remote archive already exists but you have no pulled baseline. ` +
            `\`pnpm pull\` to adopt it (then re-ingest), or --force to overwrite it.`,
      );
    }
    throw err;
  }
  await fs.promises.writeFile(etagPath(archive), newEtag);

  await publishObject(browser, BROWSER_KEY, "overwrite");
  logger.info({ event: "push_done", etag: newEtag });
}

main().catch((err) => {
  logger.error({ event: "push_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
