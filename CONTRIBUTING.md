# Contributing / operating the pipeline

This repo is a daily scraper for the Municipality of Anchorage property
database into a plain DuckDB database with full SCD2 history, published as
two `.duckdb` files on Cloudflare R2. Consumers of the published files don't
need any of this — see the [README](README.md). This document covers running,
developing, and publishing the pipeline.

## How the scrape works

No Playwright needed: MOA publishes an official ArcGIS Feature Service,
[`PropertyInformation_Hosted`](https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0).
It carries ~99.7k polygon features / ~98.5k distinct parcels. The scraper
pages through the REST query endpoint (GeoJSON, 2,000 features/page, 4 pages
in flight, retries with exponential backoff).

Multi-part parcels (one `Parcel_ID`, several polygon rows) are collapsed to
one row per parcel with their geometries unioned; `feature_count` records how
many source features merged. The source also carries ~1k features with an
empty `Parcel_ID` and all-null attributes (uncatalogued geometry slivers, no
CAMA record) — these cannot be keyed and are dropped at staging; the count is
logged as `stage_dropped_unkeyed`. `PUBDATE` is treated as volatile export
metadata: stored, but excluded from change detection so the nightly republish
never creates spurious history versions.

Change detection is driven by `attr_hash` — md5 over all metadata + geometry.

## The published artifacts

Each run produces two `.duckdb` files, both written at
`storage_compatibility_version 'v1.0.0'` so any DuckDB ≥ 1.0 reads them with
no extension:

- **`anchorage.duckdb`** — the archive and the system of record: `parcels`
  (full SCD2 history, all columns including `geom_wkb` and `attr_hash`),
  `ingest_runs`, and the `parcels_current` view. The nightly job restores
  this file from the bucket, SCD2-merges the fresh snapshot into it,
  checkpoints, and republishes it.
- **`anchorage-current.duckdb`** — the browser artifact, derived from the
  archive after each merge: `parcels_current` as a materialised table
  (current rows only, `geom_wkb` and `attr_hash` dropped) plus `ingest_runs`.
  Browsers download attached files whole (duckdb-wasm never issues range
  requests), so this file is kept small and does not grow with history.

One sharp edge to know about: any view inside a published file must be
created while that file is the **primary** database, not while it is
`ATTACH`ed under an alias — DuckDB bakes the creating session's catalog
qualification into the view body, and the view then breaks under any other
reader alias. `src/store.ts` opens the archive as the primary database for
exactly this reason, and the DQ suite attaches the published file under an
alias to catch regressions.

## Commands

```sh
npm install

npm run ingest   # fetch full layer → SCD2-merge into the archive + build browser file (the cron command)
npm run dq       # data-quality suite (vitest) over the published files; DB_ATTACH / DB_ATTACH_CURRENT override
npm run daily    # ingest + dq over the local database in one shot
npm test         # offline SCD2 merge test against a throwaway database
npm run sql -- "SELECT ... FROM lake.parcels_current LIMIT 5"   # ad-hoc queries
```

Each command has a `:prod` variant (`ingest:prod`, `daily:prod`, `sql:prod`)
that loads `.env` and operates on the public R2 files instead of the
local dev database — see [Publishing to Cloudflare R2](#publishing-to-cloudflare-r2).

All commands emit structured JSON logs (pino) on stdout — one event per line
(`fetch_progress`, `merge_start`, `ingest_done`, ...). Pipe through
`npx pino-pretty` when reading by hand. `LOG_LEVEL=debug` adds per-page detail.

### Cron

The ingest is idempotent (an unchanged upstream produces zero new rows), so
running it more often than the source updates is harmless.

```cron
# every day at 06:15, keep a log trail
15 6 * * * cd /Users/nc/anchorage-parcel-lake && /usr/bin/env npm run daily >> data/cron.log 2>&1
```

## Layout

```
data/db/anchorage.duckdb            archive, dev target (gitignored)
data/db/anchorage-current.duckdb    browser artifact, dev target
data/db-r2/                         same two files for the R2 target (writer's local copy)
data/raw/<run-id>/                  raw NDJSON pages (deleted after success; KEEP_RAW=1 to retain)
```

## Querying the dev database

`npm run sql -- "..."` attaches the archive as `lake`, exactly like a reader
of the published file. Any DuckDB ≥ 1.0 works too:

```sql
LOAD spatial;
ATTACH 'data/db/anchorage.duckdb' AS lake (READ_ONLY);
```

## Publishing to Cloudflare R2

Both files are served publicly from the bucket: anyone can query them over
HTTPS with no credentials.

How it works (`DB_TARGET=r2`, set via `.env` for the `:prod` scripts):

- The writer works on a local copy of the archive at
  `data/db-r2/anchorage.duckdb`. If that file is missing (fresh checkout,
  ephemeral CI runner), it is first restored by downloading `anchorage.duckdb`
  from the bucket; only if the bucket has none either (very first run) is a
  fresh database bootstrapped.
- The merge runs inside a single transaction against the local file; the
  session is closed with a checkpoint so no `.wal` remains, and the run
  refuses to publish if one does.
- The browser artifact is derived from the closed archive, then both files
  are uploaded. Each PUT is atomic per object, so readers never see a torn
  file — but the two objects can briefly disagree with each other
  mid-refresh, which is accepted and documented rather than engineered
  around.
- The archive's size is logged on every run (`archive_size`); a single PUT is
  right at today's ~56 MB, and that log line is how we notice it approaching
  multipart-upload territory.

One-time setup:

1. Cloudflare dashboard → R2 (requires a payment method on file; this dataset
   fits comfortably in the free tier) → create bucket.
2. Bucket → Settings → Public access → enable the `r2.dev` subdomain (or
   attach a custom domain).
3. R2 → Manage API tokens → create a token with **Object Read & Write** scoped
   to the bucket.
4. `cp .env.example .env` and fill in bucket, account ID, token keys, public URL.
5. `npm run daily:prod` — bootstraps the database, backfills the full layer,
   publishes.

To also serve browser-based clients (e.g. [shell.duckdb.org](https://shell.duckdb.org)),
add a CORS policy on the bucket (Settings → CORS) allowing `GET` from the
origins you care about.

The dev and prod databases are fully independent: `npm run ingest` never
touches R2, and the prod archive's history starts at its own first ingest.

## Data quality

`npm run dq` runs [test/dq.test.ts](test/dq.test.ts) — 24 checks, each `error`
(impossible states: duplicate current rows, overlapping validity intervals,
missing geometry, missing owner on a positive-value parcel, negative values,
parcels outside the Anchorage bbox, stale ingest, browser artifact out of
sync with the archive) or `warn` with an allowance for real-world dirtiness
verified in the source (a couple of ~1 m² sliver parcels, a few OGC-invalid
rings). Error-severity failures fail the vitest run so cron/CI can alert;
warn-severity overruns log a warning but still pass. By default the suite
attaches the published files over HTTPS like the other tests;
`npm run daily` / `daily:prod` point `DB_ATTACH` / `DB_ATTACH_CURRENT` at the
files the ingest just wrote, so an ingest is checked before it ships. All
timestamps are naive UTC throughout — DQ time checks compare against
`now() AT TIME ZONE 'UTC'`, never local time.

## Safety rails

- The run aborts **before merging** if fewer than 99% of the server-reported
  features were fetched, or if the snapshot has < 95% of the archive's current
  parcel count (a broken upstream export would otherwise spuriously "retire"
  thousands of parcels). Override the latter with `ALLOW_SHRINK=1`.
- The SCD2 merge runs in a single transaction — a crash mid-merge leaves the
  archive at the previous snapshot.
- The run refuses to publish if a `.wal` file remains beside the archive
  after close.

## Configuration

Config via env vars: `DB_TARGET`, `DB_DIR`, `RAW_DIR`, `KEEP_RAW`,
`PAGE_SIZE`, `FETCH_CONCURRENCY`, `FETCH_RETRIES`, `FETCH_TIMEOUT_MS`,
`MIN_SNAPSHOT_RATIO`, `ALLOW_SHRINK`, `LOG_LEVEL`, `MOA_SERVICE_URL`, and the
`R2_*` variables in `.env.example`.
