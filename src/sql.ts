/**
 * Ad-hoc SQL against the lake:  npm run sql -- "SELECT ... FROM lake.parcels_current LIMIT 5"
 * (Works regardless of the standalone duckdb CLI's DuckLake catalog version.)
 */
import { config } from "./config.js";
import { openLake, rowObjects } from "./lake.js";

const sql = process.argv[2];
if (!sql) {
  console.error('usage: npm run sql -- "SELECT ..."');
  process.exit(2);
}

const lake = await openLake(config.lakeDir);
try {
  const rows = await rowObjects(lake.conn, sql);
  const plain = (v: unknown): unknown => {
    if (typeof v === "bigint") return Number(v);
    if (v && typeof v === "object" && "micros" in v) return String(v); // DuckDB timestamp values
    return v;
  };
  console.log(JSON.stringify(rows, (_k, v) => plain(v), 2));
} finally {
  await lake.close();
}
