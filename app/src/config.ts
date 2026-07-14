/**
 * Where the browser artifact (anchorage-current.duckdb) is fetched from.
 *
 * - VITE_DATA_URL overrides everything (point at another bucket or file).
 * - In dev, vite serves the local workspace's artifact (see vite.config.ts),
 *   so the app explores exactly what the pipeline last built on this machine.
 * - Production builds read the canonical published dataset.
 */
export const PUBLISHED_BROWSER_URL =
  'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb';

export const DATA_URL: string =
  import.meta.env.VITE_DATA_URL ??
  (import.meta.env.DEV
    ? new URL('/anchorage-current.duckdb', window.location.origin).href
    : PUBLISHED_BROWSER_URL);

/** The in-memory table every view in the app queries. */
export const MAIN_TABLE = 'parcels';
