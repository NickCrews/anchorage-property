# anchorage-parcel-lake

Daily scraper for the Municipality of Anchorage property database into a local
[DuckLake](https://ducklake.select/) (DuckDB lakehouse: parquet data files + a
transactional catalog), with a full **history trail** — you can ask who owned
any parcel, and what it was worth, at any point in time since the lake started.

## Data source

No Playwright needed: MOA publishes an official ArcGIS Feature Service,
[`PropertyInformation_Hosted`](https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0)
("parcel boundaries merged with Property Appraisal CAMA information, updated
daily except weekends"). It carries ~99.7k polygon features / ~98.5k distinct
parcels with owner, appraised land/building/total value, exemptions, taxable
value, legal description, deed references, zoning, site address, and geometry.
The scraper pages through it via the REST query endpoint (GeoJSON, 2,000
features/page, 4 pages in flight, retries with exponential backoff).

Multi-part parcels (one `Parcel_ID`, several polygon rows) are collapsed to
**one row per parcel** with their geometries unioned; `feature_count` records
how many source features merged. The source also carries ~1k features with an
empty `Parcel_ID` and all-null attributes (uncatalogued geometry slivers, no
CAMA record) — these cannot be keyed and are dropped at staging; the count is
logged as `stage_dropped_unkeyed`. `PUBDATE` is treated as volatile export
metadata: stored, but excluded from change detection so the nightly republish
never creates spurious history versions.

## Commands

```sh
npm install

npm run ingest   # fetch full layer → SCD2-merge into the lake (the cron command)
npm run dq       # data-quality suite over the prod lake (exit 1 on error-severity failures)
npm run daily    # ingest + dq in one shot
npm test         # offline SCD2 merge test against a throwaway lake
npm run sql -- "SELECT ... FROM lake.parcels_current LIMIT 5"   # ad-hoc queries
```

Each command has a `:prod` variant (`ingest:prod`, `dq:prod`, `daily:prod`,
`sql:prod`) that loads `.env` and operates on the public R2 lake instead of the
local dev lake — see [Publishing to Cloudflare R2](#publishing-to-cloudflare-r2).

All commands emit structured JSON logs (pino) on stdout — one event per line
(`fetch_progress`, `merge_start`, `ingest_done`, `dq_check`, ...). Pipe through
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
data/lake/catalog.ducklake      DuckLake catalog, dev lake (DuckDB file, gitignored)
data/lake/parquet/              parquet data files, dev lake
data/lake-r2/catalog.ducklake   catalog of the public R2 lake (writer's copy; parquet lives in the bucket)
data/raw/<run-id>/              raw NDJSON pages (deleted after success; KEEP_RAW=1 to retain)
```

### Tables

- **`lake.parcels`** — SCD2 version rows. All CAMA metadata columns, plus:
  - `geom_wkb` — parcel geometry, WKB, EPSG:4326
  - `area_m2` — geodesically honest area (computed in EPSG:3338 Alaska Albers;
    Web-Mercator areas are ~4× inflated at 61°N)
  - `attr_hash` — md5 over all metadata + geometry, drives change detection
  - `valid_from` / `valid_to` / `is_current` — validity interval; a new version
    row is created only when something actually changed
- **`lake.parcels_current`** — view of current versions
- **`lake.ingest_runs`** — one row per run: counts of new / changed / retired /
  unchanged parcels

On top of the explicit SCD2 trail, DuckLake itself snapshots every committed
transaction, so `SELECT * FROM lake.parcels AT (VERSION => n)` time travel also
works as a second, physical audit layer.

## Querying

`npm run sql -- "..."` always works. Any DuckDB whose DuckLake extension
matches the catalog version also works (the pipeline's bundled DuckDB writes
DuckLake 0.3; a newer standalone CLI will offer `AUTOMATIC_MIGRATION` —
don't accept from a CLI newer than the pipeline's, or the pipeline can no
longer write):

```sql
INSTALL ducklake; LOAD ducklake; LOAD spatial;
ATTACH 'ducklake:data/lake/catalog.ducklake' AS lake (DATA_PATH 'data/lake/parquet', READ_ONLY);
```

Who owned a parcel two years ago, and what was it worth?

```sql
SELECT owner_name, appraised_total_value
FROM lake.parcels
WHERE parcel_id = '01038131017'
  AND valid_from <= TIMESTAMP '2024-07-05'
  AND (valid_to IS NULL OR valid_to > TIMESTAMP '2024-07-05');
```

Full ownership/value history of one parcel:

```sql
SELECT valid_from, valid_to, owner_name, appraised_total_value, taxable_value
FROM lake.parcels WHERE parcel_id = '01038131017' ORDER BY valid_from;
```

Every parcel that changed hands in the last 90 days:

```sql
SELECT n.parcel_id, o.owner_name AS old_owner, n.owner_name AS new_owner, n.valid_from
FROM lake.parcels n
JOIN lake.parcels o
  ON o.parcel_id = n.parcel_id AND o.valid_to = n.valid_from
WHERE n.valid_from > (now() AT TIME ZONE 'UTC') - INTERVAL 90 DAY
  AND o.owner_name IS DISTINCT FROM n.owner_name;
```

Spatial — parcels within 500 m of a point, with owner:

```sql
SELECT parcel_id, owner_name, parcel_address, round(area_m2) AS m2
FROM lake.parcels_current
WHERE ST_DWithin(
  ST_Transform(ST_GeomFromWKB(geom_wkb), 'EPSG:4326', 'EPSG:3338', always_xy := true),
  ST_Transform(ST_Point(-149.8997, 61.2176), 'EPSG:4326', 'EPSG:3338', always_xy := true),
  500);
```

## Publishing to Cloudflare R2

The lake can be served as a [public read-only DuckLake](https://ducklake.select/docs/stable/duckdb/guides/public_ducklake_on_object_storage):
anyone can query it over HTTPS with no credentials.

How it works (`LAKE_TARGET=r2`, set via `.env` for the `:prod` scripts):

- The writer works on a local copy of the catalog at
  `data/lake-r2/catalog.ducklake`. If that file is missing (fresh checkout,
  ephemeral CI runner), it is first restored by downloading `catalog.ducklake`
  from the bucket; only if the bucket has none either (very first run) is a new
  catalog created, with the bucket's **public `https://` URL** as its persisted
  data path (what readers resolve parquet paths against; DuckLake stores file
  paths relative to it and [doesn't allow changing it
  later](https://ducklake.select/docs/stable/duckdb/guides/using_a_remote_data_path)).
- Each session attaches with `OVERRIDE_DATA_PATH` pointing at the same prefix
  via the authenticated `r2://` endpoint, so the merge writes parquet directly
  into the bucket.
- After a successful merge, the catalog file is uploaded to the bucket as
  `catalog.ducklake`. That single PUT is the atomic publish — readers never see
  a catalog that references parquet files not yet uploaded.

One-time setup:

1. Cloudflare dashboard → R2 (requires a payment method on file; this lake fits
   comfortably in the free tier) → create bucket.
2. Bucket → Settings → Public access → enable the `r2.dev` subdomain (or attach
   a custom domain — decide **before** the first prod run, the URL is baked into
   the catalog).
3. R2 → Manage API tokens → create a token with **Object Read & Write** scoped
   to the bucket.
4. `cp .env.example .env` and fill in bucket, account ID, token keys, public URL.
5. `npm run daily:prod` — bootstraps the catalog, backfills the full layer,
   publishes.

Anyone can then query it from any DuckDB (spatial queries need `LOAD spatial`):

```sql
INSTALL ducklake;
ATTACH 'ducklake:https://<public-url>/catalog.ducklake' AS lake;
SELECT count(*) FROM lake.parcels_current;
```

To also query it from browser-based clients (e.g. [shell.duckdb.org](https://shell.duckdb.org)),
add a CORS policy on the bucket (Settings → CORS) allowing `GET` from the
origins you care about.

The dev and prod lakes are fully independent: `npm run ingest` never touches
R2, and the prod lake's history starts at its own first ingest.

## Data quality

`npm run dq` runs 22 checks against the production lake, each `error`
(impossible states: duplicate current rows, overlapping validity intervals,
missing geometry, missing owner on a positive-value parcel, negative values,
parcels outside the Anchorage bbox, stale ingest) or `warn` with an allowance
for real-world dirtiness verified in the source (a couple of ~1 m² sliver
parcels, a few OGC-invalid rings). Error-severity failures exit non-zero so
cron/CI can alert. All timestamps are naive UTC throughout — DQ time checks
compare against `now() AT TIME ZONE 'UTC'`, never local time.

## Safety rails

- The run aborts **before merging** if fewer than 99% of the server-reported
  features were fetched, or if the snapshot has < 95% of the lake's current
  parcel count (a broken upstream export would otherwise spuriously "retire"
  thousands of parcels). Override the latter with `ALLOW_SHRINK=1`.
- The SCD2 merge runs in a single DuckLake transaction — a crash mid-merge
  leaves the lake at the previous snapshot.

Config via env vars: `LAKE_TARGET`, `LAKE_DIR`, `RAW_DIR`, `KEEP_RAW`,
`PAGE_SIZE`, `FETCH_CONCURRENCY`, `FETCH_RETRIES`, `FETCH_TIMEOUT_MS`,
`MIN_SNAPSHOT_RATIO`, `ALLOW_SHRINK`, `LOG_LEVEL`, `MOA_SERVICE_URL`, and the
`R2_*` variables in `.env.example`.
