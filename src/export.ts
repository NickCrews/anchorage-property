import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { logger } from "./logger.js";
import { sqlStr } from "./quote.js";

/**
 * Build the browser artifact from a checkpointed archive: current rows only,
 * with `geom_wkb` (40% of the bytes) and `attr_hash` (internal change
 * detection) dropped. duckdb-wasm never issues HTTP range requests — a browser
 * downloads whatever file it attaches in full — so this file's job is to be
 * small and to stay small: it grows with parcel count, not with history.
 *
 * Dropping `geom_wkb` would leave browser readers with no way to put a parcel
 * on a map, so the export adds `centroid_lon` / `centroid_lat` (EPSG:4326,
 * NULL where the parcel has no geometry): two DOUBLEs per row buy back
 * mapping at a fraction of the cost of the full polygons.
 *
 * `parcels_current` is a materialised table here, not a view, since the
 * history it would filter is not shipped. Its columns match the archive's
 * `parcels_current` view minus the two dropped ones, plus the two centroids.
 *
 * Pure function of the archive file; call it only after the archive's
 * connection is closed and checkpointed.
 */
export async function buildBrowserArtifact(archivePath: string, outPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.rm(outPath, { force: true });
  await fs.promises.rm(`${outPath}.wal`, { force: true });

  const instance = await DuckDBInstance.create(outPath, {
    storage_compatibility_version: "v1.0.0",
  });
  const conn = await instance.connect();
  try {
    await conn.run("INSTALL spatial; LOAD spatial;");
    await conn.run(`ATTACH ${sqlStr(archivePath)} AS archive (READ_ONLY)`);
    // parcel_id-ordered so per-column zone maps prune on the key people filter by.
    await conn.run(`
      CREATE TABLE parcels_current AS
      SELECT * EXCLUDE (geom_wkb, attr_hash),
             ST_X(ST_Centroid(ST_GeomFromWKB(geom_wkb))) AS centroid_lon,
             ST_Y(ST_Centroid(ST_GeomFromWKB(geom_wkb))) AS centroid_lat
      FROM archive.parcels_current
      ORDER BY parcel_id
    `);
    await conn.run(`CREATE TABLE ingest_runs AS SELECT * FROM archive.ingest_runs`);
    await conn.run("DETACH archive");
    await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
    instance.closeSync();
  }

  const { size } = await fs.promises.stat(outPath);
  logger.info({ event: "browser_artifact_built", outPath, bytes: size });
}
