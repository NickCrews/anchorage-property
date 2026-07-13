/**
 * Ad-hoc SQL against the workspace's archive:
 *   pnpm sql -- "SELECT ... FROM lake.parcels_current LIMIT 5"
 * Attaches the archive under the alias `lake`, exactly as a reader of the
 * published file would.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { config, dbPaths } from "./config.js";
import { rowObjects } from "./store.js";

const sql = process.argv[2];
if (!sql) {
  console.error('usage: npm run sql -- "SELECT ..."');
  process.exit(2);
}

const { archive } = dbPaths(config.workspaceDir);
const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();
try {
  await conn.run("INSTALL spatial; LOAD spatial;");
  await conn.run(`ATTACH '${archive.replace(/'/g, "''")}' AS lake (READ_ONLY)`);
  const rows = await rowObjects(conn, sql);
  const plain = (v: unknown): unknown => {
    if (typeof v === "bigint") return Number(v);
    if (v && typeof v === "object" && "micros" in v) return String(v); // DuckDB timestamp values
    return v;
  };
  console.log(JSON.stringify(rows, (_k, v) => plain(v), 2));
} finally {
  conn.closeSync();
  instance.closeSync();
}
