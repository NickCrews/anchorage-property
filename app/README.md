# Anchorage Parcel Explorer

A browser data app for exploring the [anchorage-parcel-lake](../README.md)
dataset: every parcel in the Municipality of Anchorage on a deck.gl map,
cross-filtered Mosaic charts, a profiler table, and a full SQL editor — all
running on duckdb-wasm in the browser, with no backend.

Built with [SQLRooms](https://sqlrooms.org/), started from the
[deckgl-mosaic example](https://github.com/sqlrooms/examples/tree/main/deckgl-mosaic)
(`npx giget gh:sqlrooms/examples/deckgl-mosaic`).

## How it gets data

On startup the app attaches `anchorage-current.duckdb` (the ~23 MB browser
artifact, downloaded in full) and copies `parcels_current` into an in-memory
`parcels` table, adding a few derived columns for the charts (value columns
capped near p98, junk years/dates nulled — see `src/store.ts`). Every query
after that — map, charts, profiler, SQL editor — is local.

Where the artifact comes from (see `src/config.ts`):

- **dev** (`pnpm dev`): served by vite from `../workspaces/<WORKSPACE>/`,
  so you explore exactly what the pipeline last built on your machine.
  Run `pnpm run pull` (or `ingest`) in the repo root first.
- **production build**: the canonical published dataset on R2.
- `VITE_DATA_URL` overrides both.

The map draws each parcel at its centroid (`centroid_lon` / `centroid_lat`,
which `src/export.ts` in the repo root computes into the browser artifact),
colored by appraised total value.

## Running

```sh
pnpm install        # in the repo root (pnpm workspace)
pnpm run app        # dev server (or `pnpm dev` in this directory)
pnpm --dir app build   # production bundle in app/dist/
```

## Pointers

- `src/store.ts` — room store: duckdb-wasm connector, data loading, layout
- `src/components/map/MapView.tsx` — deck.gl map, color scale, brush
- `src/components/filters/filterPlots.ts` — Mosaic chart specs
- `src/components/filters/ParcelProfiler.tsx` — cross-filtered data table
- In dev, `window.roomStore` exposes the live store for console debugging
