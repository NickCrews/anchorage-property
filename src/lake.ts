import fs from "node:fs";
import path from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { lakeColumnsDdl } from "./fields.js";
import type { OpenLakeOptions } from "./config.js";

export interface Lake {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  close(): Promise<void>;
}

const sqlQuote = (s: string) => s.replace(/'/g, "''");

/**
 * Open an in-memory DuckDB session with the DuckLake catalog attached as `lake`
 * and the spatial extension loaded. This only opens: syncing the catalog with
 * the bucket (restoreCatalog / publishCatalog) is the caller's responsibility,
 * out of band of the session.
 *
 * For the r2 data target the catalog file is still local, but its persisted
 * data path is the bucket's public https:// URL (what unauthenticated readers
 * resolve parquet files against — DuckLake stores file paths relative to it and
 * does not allow changing it later). This session attaches with
 * OVERRIDE_DATA_PATH so reads and writes go through the authenticated r2://
 * endpoint of the same prefix instead.
 */
export async function openLake(opts: OpenLakeOptions): Promise<Lake> {
  const { catalog, data } = opts;
  if (data.kind === "r2" && !fs.existsSync(catalog) && !opts.createIfMissing) {
    throw new Error(
      `No catalog at ${catalog}. Restore the published catalog first (restoreCatalog), ` +
        `or pass createIfMissing: true to bootstrap a brand-new lake.`,
    );
  }

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL ducklake; LOAD ducklake;");
  await conn.run("INSTALL spatial; LOAD spatial;");
  await fs.promises.mkdir(path.dirname(catalog), { recursive: true });
  if (data.kind === "r2") {
    const { r2 } = data;
    await conn.run("INSTALL httpfs; LOAD httpfs;");
    await conn.run(
      `CREATE OR REPLACE SECRET r2_lake (
         TYPE r2,
         KEY_ID '${sqlQuote(r2.accessKeyId)}',
         SECRET '${sqlQuote(r2.secretAccessKey)}',
         ACCOUNT_ID '${sqlQuote(r2.accountId)}'
       )`,
    );
    if (!fs.existsSync(catalog)) {
      await conn.run(
        `ATTACH 'ducklake:${sqlQuote(catalog)}' AS lake (DATA_PATH '${sqlQuote(r2.publicUrl)}/parquet')`,
      );
      await conn.run("DETACH lake");
    }
    await conn.run(
      `ATTACH IF NOT EXISTS 'ducklake:${sqlQuote(catalog)}' AS lake
       (DATA_PATH 'r2://${sqlQuote(r2.bucket)}/parquet', OVERRIDE_DATA_PATH true)`,
    );
  } else {
    await fs.promises.mkdir(data.dir, { recursive: true });
    await conn.run(
      `ATTACH IF NOT EXISTS 'ducklake:${sqlQuote(catalog)}' AS lake (DATA_PATH '${sqlQuote(data.dir)}')`,
    );
  }
  return {
    instance,
    conn,
    async close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

export async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS lake.parcels (
      parcel_id VARCHAR NOT NULL,
      ${lakeColumnsDdl()},
      feature_count INTEGER,
      geom_wkb BLOB,
      area_m2 DOUBLE,
      attr_hash VARCHAR NOT NULL,
      valid_from TIMESTAMP NOT NULL,
      valid_to TIMESTAMP,
      is_current BOOLEAN NOT NULL
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS lake.ingest_runs (
      run_id VARCHAR NOT NULL,
      started_at TIMESTAMP NOT NULL,
      finished_at TIMESTAMP NOT NULL,
      status VARCHAR NOT NULL,
      server_count BIGINT,
      source_features BIGINT,
      distinct_parcels BIGINT,
      new_parcels BIGINT,
      changed_parcels BIGINT,
      retired_parcels BIGINT,
      unchanged_parcels BIGINT
    )
  `);
  await conn.run(`
    CREATE OR REPLACE VIEW lake.parcels_current AS
    SELECT * EXCLUDE (valid_to, is_current)
    FROM lake.parcels
    WHERE is_current
  `);
}

/** Single-value convenience query. */
export async function scalar<T = unknown>(conn: DuckDBConnection, sql: string): Promise<T> {
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRows();
  return rows[0]?.[0] as T;
}

export async function rowObjects(conn: DuckDBConnection, sql: string): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects() as Record<string, unknown>[];
}
