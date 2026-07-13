import fs from "node:fs";
import path from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { exemptionsSchemaSql } from "./exemptions.js";
import { lakeColumnsDdl } from "./fields.js";

export interface Store {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  /** Local filesystem path of the .duckdb file this store owns. */
  dbPath: string;
  close(): Promise<void>;
}

export interface OpenStoreOptions {
  /** Local filesystem path of the archive .duckdb file. */
  dbPath: string;
  /**
   * Permit bootstrapping a brand-new database when `dbPath` does not exist.
   * A missing file throws by default, so a caller that expected a pulled
   * working copy fails loudly instead of silently forking the published
   * history.
   */
  createIfMissing?: boolean;
}

/**
 * Open the parcel database as the *primary* database (not ATTACHed under an
 * alias) with the spatial extension loaded. Opening this file only: syncing
 * with the bucket (`pull` / `push`) is the caller's responsibility, out of
 * band of the session.
 *
 * Primary, not attached, matters beyond convenience: DuckDB persists a view's
 * body with its catalog qualification baked in, so a view created while the
 * file is attached as `out` reads `out.parcels` forever and breaks under any
 * other reader alias. Views created here stay unqualified and alias-agnostic.
 *
 * storage_compatibility_version pins the on-disk format to what DuckDB 1.0
 * can read (costs ~1% in size), so the published file has no reader version
 * floor and needs no extension.
 */
export async function openStore(opts: OpenStoreOptions): Promise<Store> {
  const { dbPath } = opts;
  if (!fs.existsSync(dbPath) && !opts.createIfMissing) {
    throw new Error(
      `No database at ${dbPath}. Pull the published archive first (pnpm pull), ` +
        `or pass createIfMissing: true to bootstrap a brand-new database.`,
    );
  }
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
  const instance = await DuckDBInstance.create(dbPath, {
    storage_compatibility_version: "v1.0.0",
  });
  const conn = await instance.connect();
  await conn.run("INSTALL spatial; LOAD spatial;");
  return {
    instance,
    conn,
    dbPath,
    async close() {
      // Fold the WAL into the file so the published object is a complete,
      // un-torn database on its own. Swallow failures: close() also runs on
      // error paths, where the original error matters more.
      await conn.run("CHECKPOINT").catch(() => {});
      conn.closeSync();
      instance.closeSync();
    },
  };
}

export async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS parcels (
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
    CREATE TABLE IF NOT EXISTS ingest_runs (
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
    CREATE OR REPLACE VIEW parcels_current AS
    SELECT * EXCLUDE (valid_to, is_current)
    FROM parcels
    WHERE is_current
  `);
  // The owner-type rules and macros ship inside the archive so readers can
  // classify without reimplementing them; see src/exemptions.ts.
  for (const statement of exemptionsSchemaSql()) {
    await conn.run(statement);
  }
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
