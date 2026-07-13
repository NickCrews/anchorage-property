/**
 * Data-quality suite over the published artifacts — a thin vitest wrapper
 * around the one check list in src/checks.ts (`push` runs the same
 * error-severity checks in-process before uploading, and `pnpm verify` runs
 * the full suite from the CLI; this wrapper exists for CI-style reporting).
 *
 * Runs against the published files over HTTPS by default, so it needs
 * network. Point DB_ATTACH / DB_ATTACH_CURRENT at local .duckdb files (e.g.
 * `workspaces/r2/anchorage.duckdb`) to check a copy before it is pushed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { CHECKS, openCheckConnection, runCheck } from "../src/checks.js";
import { PUBLIC_ARCHIVE_URL, PUBLIC_BROWSER_URL } from "../src/config.js";

const attach = process.env.DB_ATTACH ?? PUBLIC_ARCHIVE_URL;
const attachCurrent = process.env.DB_ATTACH_CURRENT ?? PUBLIC_BROWSER_URL;

let db: Awaited<ReturnType<typeof openCheckConnection>>;

beforeAll(async () => {
  db = await openCheckConnection(attach, attachCurrent);
});

afterAll(() => {
  db?.close();
});

for (const check of CHECKS) {
  it(check.name, async () => {
    const outcome = await runCheck(db.conn, check);
    if (outcome.status === "pass") return;
    if (outcome.status === "warn") {
      console.warn(outcome.detail);
      return;
    }
    expect.fail(outcome.detail);
  });
}
