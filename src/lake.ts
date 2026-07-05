import fs from "node:fs";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { lakeColumnsDdl } from "./fields.js";
import { lakePaths } from "./config.js";

export interface Lake {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  close(): Promise<void>;
}

const sqlQuote = (s: string) => s.replace(/'/g, "''");

/**
 * Open an in-memory DuckDB session with the DuckLake catalog attached as `lake`
 * and the spatial extension loaded.
 */
export async function openLake(lakeDir: string): Promise<Lake> {
  const { catalog, dataPath } = lakePaths(lakeDir);
  await fs.promises.mkdir(dataPath, { recursive: true });

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL ducklake; LOAD ducklake;");
  await conn.run("INSTALL spatial; LOAD spatial;");
  await conn.run(
    `ATTACH IF NOT EXISTS 'ducklake:${sqlQuote(catalog)}' AS lake (DATA_PATH '${sqlQuote(dataPath)}')`,
  );
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
