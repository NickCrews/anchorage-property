/**
 * audit [archive] [browser] [--published] — run the full data-quality suite
 * against a copy of the artifacts. Defaults to the workspace's working copy;
 * both arguments also accept https:// URLs, and --published is shorthand for
 * the canonical published files:
 *
 *   pnpm run audit                    # the workspace's working copy
 *   WORKSPACE=exp pnpm run audit      # another workspace's
 *   pnpm run audit --published        # the published dataset, over HTTPS
 *   pnpm run audit https://.../anchorage.duckdb https://.../anchorage-current.duckdb
 *
 * (`pnpm run audit`, not `pnpm audit` — the bare form is pnpm's built-in
 * dependency vulnerability scan.)
 *
 * Exits non-zero on any error-severity failure; warn-severity overruns are
 * logged but pass. `push` runs the same error-severity checks itself before
 * uploading — this command is for auditing anything else.
 */
import path from "node:path";
import { config, dbPaths, PUBLIC_ARCHIVE_URL, PUBLIC_BROWSER_URL } from "./config.js";
import { logger } from "./logger.js";
import { openCheckConnection, runChecks } from "./checks.js";

const isUrl = (s: string) => /^https?:\/\//.test(s);
const resolve = (s: string) => (isUrl(s) ? s : path.resolve(s));

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--published");
  const published = process.argv.includes("--published");
  const defaults = published
    ? { archive: PUBLIC_ARCHIVE_URL, browser: PUBLIC_BROWSER_URL }
    : dbPaths(config.workspaceDir);
  const archive = args[0] ? resolve(args[0]) : defaults.archive;
  const browser = args[1]
    ? resolve(args[1])
    : isUrl(archive)
      ? defaults.browser
      : dbPaths(path.dirname(archive)).browser;

  logger.info({ event: "audit_start", archive, browser });
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
      event: "audit_done",
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
  logger.error({ event: "audit_failed", err: String(err), stack: err?.stack });
  process.exitCode = 1;
});
