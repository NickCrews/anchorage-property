/**
 * verify [archive] [browser] — run the full data-quality suite against a copy
 * of the artifacts. Defaults to the workspace's working copy; both arguments
 * also accept https:// URLs, so the published files can be audited in place:
 *
 *   pnpm verify                       # the workspace's working copy
 *   WORKSPACE=exp pnpm verify         # another workspace's
 *   pnpm verify https://.../anchorage.duckdb https://.../anchorage-current.duckdb
 *
 * Exits non-zero on any error-severity failure; warn-severity overruns are
 * logged but pass. `push` runs the same error-severity checks itself before
 * uploading — this command is for auditing anything else.
 */
import path from "node:path";
import { config, dbPaths } from "./config.js";
import { logger } from "./logger.js";
import { openCheckConnection, runChecks } from "./checks.js";

const isUrl = (s: string) => /^https?:\/\//.test(s);
const resolve = (s: string) => (isUrl(s) ? s : path.resolve(s));

async function main() {
  const defaults = dbPaths(config.workspaceDir);
  const archive = process.argv[2] ? resolve(process.argv[2]) : defaults.archive;
  const browser = process.argv[3]
    ? resolve(process.argv[3])
    : isUrl(archive)
      ? defaults.browser
      : dbPaths(path.dirname(archive)).browser;

  logger.info({ event: "verify_start", archive, browser });
  const db = await openCheckConnection(archive, browser);
  try {
    const outcomes = await runChecks(db.conn);
    for (const o of outcomes) {
      if (o.status === "pass") continue;
      if (o.status === "warn") logger.warn({ event: "check_warn", detail: o.detail });
      else logger.error({ event: "check_failed", detail: o.detail });
    }
    const failed = outcomes.filter((o) => o.status === "fail").length;
    logger.info({
      event: "verify_done",
      checks: outcomes.length,
      failed,
      warned: outcomes.filter((o) => o.status === "warn").length,
    });
    if (failed > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error({ event: "verify_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
