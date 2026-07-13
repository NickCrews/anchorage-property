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

## The data lifecycle

The lifecycle is modeled on `git`: **the archive in R2 is the only source of
truth; a working copy is a local, ETag-validated cache of it, living in a
named workspace; a sandbox is just another workspace.** Each action is an
independently runnable verb:

| Verb | Does | Network |
| --- | --- | --- |
| `pnpm pull [path]` | remote archive → workspace; records the source ETag | in only |
| `pnpm ingest [path]` | fetch upstream + SCD2-merge into the workspace's copy + build browser artifact | upstream in only; **never touches the remote** |
| `pnpm run audit [path]` | run the data-quality checks against a copy (`--published` for the published files) | none, or HTTPS if pointed at URLs |
| `pnpm push [path]` | workspace's copy → remote, guarded (see below) | out only |

(`audit` is the one verb that needs the `run`: bare `pnpm audit` is pnpm's
built-in dependency vulnerability scan, and built-ins shadow scripts.)

"Don't push" is the default, not something you must prevent:

```sh
pnpm pull            # prod -> workspaces/<name>/anchorage.duckdb, remembers ETag
pnpm ingest          # merge today's snapshot into it, local only
pnpm sql -- "..."    # inspect
# walk away: remote untouched, nothing published
pnpm push            # only if and when you decide to
```

The daily CI job is nothing more than the canned sequence
`pull && ingest && audit && push` — a script, not a special mode — and every
prefix of that sequence is a legitimate place to stop.

### Workspaces

A workspace is a directory `workspaces/<name>/` holding one working copy and
everything that belongs to it: the archive, the browser artifact, the ETag
sidecar recording which remote object the copy descends from, and per-run raw
downloads. `WORKSPACE=<name>` selects it (default `default`); every verb
targets the selected workspace unless given an explicit path.

The name is only a label for a local context. Whether a sync is *possible* is
decided by credentials — `pull`/`push` need the `R2_*` variables and refuse
with a clear message without them. Whether a sync is *safe* is decided by
lineage, tracked by the ETag sidecar:

- **`push` is self-gating:** it runs the error-severity checks in-process
  against the exact files it is about to upload and refuses on any failure,
  so an ingest is always checked before it ships. `--force` is the escape
  hatch.
- **`push` is a compare-and-swap:** it sends the pulled ETag as `If-Match`,
  so if prod moved since your pull (CI ran, someone else pushed) the push
  fails with HTTP 412 instead of silently clobbering remote history. With no
  recorded baseline (fresh empty bucket) it sends `If-None-Match: *` —
  create-if-absent. To adopt an existing remote you never pulled:
  `pnpm pull` (then re-ingest), or `pnpm push --force` to knowingly
  overwrite.
- **`pull` refuses unrelated histories:** an archive with no ETag sidecar was
  born locally — pulling over it would destroy history that was never the
  remote's. `pull` refuses, with `--force` as the escape hatch; refreshing a
  tracked copy overwrites freely.

A throwaway clone of prod is just another workspace:

```sh
WORKSPACE=exp pnpm pull            # clone prod to workspaces/exp/
WORKSPACE=exp pnpm sql -- "..."    # poke at it
rm -rf workspaces/exp              # discard
```

No `push` is aimed at it, and even a mistaken one is caught by the
compare-and-swap unless the copy genuinely descends from the current remote
object.

## The published artifacts

Each run produces two `.duckdb` files, both written at
`storage_compatibility_version 'v1.0.0'` so any DuckDB ≥ 1.0 reads them with
no extension:

- **`anchorage.duckdb`** — the archive and the system of record: `parcels`
  (full SCD2 history, all columns including `geom_wkb` and `attr_hash`),
  `ingest_runs`, and the `parcels_current` view. The daily job pulls this
  file from the bucket, SCD2-merges the fresh snapshot into it, checkpoints,
  verifies, and pushes it back.
- **`anchorage-current.duckdb`** — the browser artifact, derived from the
  archive by each ingest: `parcels_current` as a materialised table
  (current rows only, `geom_wkb` and `attr_hash` dropped) plus `ingest_runs`.
  Browsers download attached files whole (duckdb-wasm never issues range
  requests), so this file is kept small and does not grow with history.

One sharp edge to know about: any view inside a published file must be
created while that file is the **primary** database, not while it is
`ATTACH`ed under an alias — DuckDB bakes the creating session's catalog
qualification into the view body, and the view then breaks under any other
reader alias. `src/store.ts` opens the archive as the primary database for
exactly this reason, and the DQ checks attach the published file under an
alias to catch regressions.

## Commands

```sh
pnpm install

pnpm pull            # remote archive -> workspace (needs the R2_* variables, usually via .env)
pnpm ingest          # fetch full layer -> SCD2-merge into the workspace + build browser file
pnpm run audit       # data-quality audit of the workspace (or pass paths/URLs, or --published)
pnpm push            # error-severity gate + compare-and-swap upload of both files
pnpm test            # code tests: offline SCD2 merge against a throwaway database
pnpm sql -- "SELECT ... FROM lake.parcels_current LIMIT 5"   # ad-hoc queries
```

There are no `:prod` script variants: `src/config.ts` loads `.env`
automatically (real environment variables win over the file), so the same
command does the right thing for a contributor with no `.env` (local
workspace, no credentials), on a laptop with `.env`, and in CI.

All commands emit structured JSON logs (pino) on stdout — one event per line
(`fetch_progress`, `merge_start`, `ingest_done`, ...). Pipe through
`npx pino-pretty` when reading by hand. `LOG_LEVEL=debug` adds per-page detail.

### Cron

The ingest is idempotent (an unchanged upstream produces zero new rows), so
running it more often than the source updates is harmless. The daily refresh
is just the verb sequence:

```cron
# every day at 06:15, keep a log trail
15 6 * * * cd /Users/nc/anchorage-parcel-lake && pnpm pull && pnpm ingest && pnpm run audit && pnpm push >> refresh-cron.log 2>&1
```

(That is exactly what [.github/workflows/daily-refresh.yml](.github/workflows/daily-refresh.yml)
runs, one verb per step.)

## Layout

```
workspaces/<name>/anchorage.duckdb          the workspace's working copy of the archive
workspaces/<name>/anchorage-current.duckdb  browser artifact derived from it
workspaces/<name>/anchorage.duckdb.etag     remote ETag as of the last pull/push — the
                                            lineage marker behind both clobber guards
workspaces/<name>/raw/<run-id>/             raw NDJSON pages (deleted after success;
                                            KEEP_RAW=1 to retain)
```

`WORKSPACE` (default `default`) picks the `<name>`; the whole `workspaces/`
tree is gitignored.

## Querying a workspace

`pnpm sql -- "..."` attaches the workspace's archive as `lake`, exactly like
a reader of the published file. Any DuckDB ≥ 1.0 works too:

```sql
LOAD spatial;
ATTACH 'workspaces/default/anchorage.duckdb' AS lake (READ_ONLY);
```

## Publishing to Cloudflare R2

Both files are served publicly from the bucket: anyone can query them over
HTTPS with no credentials. Publishing needs the `R2_*` variables (usually via
`.env`); `pull` and `push` are the only commands that use them. How a publish
works:

- `pull` downloads `anchorage.duckdb` from the bucket into the workspace and
  records its ETag. On an empty bucket it no-ops (the first `push` then
  creates the object with `If-None-Match: *`).
- `ingest` merges inside a single transaction against the local file; the
  session is closed with a checkpoint so no `.wal` remains, and both `ingest`
  and `push` refuse to proceed if one does. The browser artifact is derived
  from the closed archive.
- `push` re-runs the error-severity checks against the exact files on disk,
  then uploads the archive with `If-Match: <pulled etag>` and the browser
  artifact after it with no precondition. Each PUT is atomic per object, so
  readers never see a torn file — but the two objects can briefly disagree
  with each other mid-refresh, which is accepted and documented rather than
  engineered around. (R2's honoring of `If-Match`/`If-None-Match` on PUT was
  verified against the live bucket on 2026-07-10.)
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
5. `pnpm pull && pnpm ingest && pnpm push` — bootstraps the database,
   backfills the full layer, publishes.

To also serve browser-based clients (e.g. [shell.duckdb.org](https://shell.duckdb.org)),
add a CORS policy on the bucket (Settings → CORS) allowing `GET` from the
origins you care about.

A credential-less contributor can still do everything local: `pnpm ingest`
bootstraps a fresh database in their workspace, and that locally-born history
is protected from a later accidental `pull` by the unrelated-histories guard.

## Testing and data quality

Two kinds of assertion, two entry points:

- **`pnpm test`** exercises *code*: the offline SCD2 merge test against a
  throwaway database with synthetic snapshots. Hermetic — no workspace, no
  network, no credentials.
- **`pnpm run audit`** interrogates *data*: every check we know how to make
  about the archive and browser artifact, against the workspace's working
  copy by default (the natural moment is right after `ingest`, before
  `push`), or any path/URL, or the published dataset with `--published`.

The checks live in one place — [src/checks.ts](src/checks.ts) — and every
gate and audit is a wrapper over that list, so they cannot drift: `push` runs
the error-severity checks in-process before uploading (this is what makes
"an ingest is checked before it ships" true — the gate is intrinsic to the
dangerous verb, not bolted on outside), and `pnpm run audit` runs the full
suite from the CLI.

Each check in [src/checks.ts](src/checks.ts) is either `error` (impossible
states: duplicate current rows, overlapping validity intervals, missing
geometry, missing owner on a positive-value parcel, negative values, parcels
outside the Anchorage bbox, stale ingest, browser artifact out of sync with
the archive) or `warn` (real-world dirtiness tolerated up to an allowance —
a couple of ~1 m² sliver parcels, a few OGC-invalid rings — plus drift
tripwires: the exemption catalog in [src/exemptions.ts](src/exemptions.ts),
the taxable-value NULL/0 semantics, and the README's Girdwood classification
claims; upstream drift should page a human, not block the nightly publish). Error-severity
failures fail the run so cron/CI can alert; warn-severity overruns log a
warning but still pass. All timestamps are naive UTC throughout — DQ time
checks compare against `now() AT TIME ZONE 'UTC'`, never local time.

## Safety rails

- The ingest aborts **before merging** if fewer than 99% of the server-reported
  features were fetched, or if the snapshot has < 95% of the archive's current
  parcel count (a broken upstream export would otherwise spuriously "retire"
  thousands of parcels). Override the latter with `ALLOW_SHRINK=1`.
- The SCD2 merge runs in a single transaction — a crash mid-merge leaves the
  archive at the previous snapshot.
- `ingest` and `push` refuse to proceed if a `.wal` file remains beside the
  archive after close.
- `push` refuses to upload a copy that fails any error-severity check.
- `push` is a compare-and-swap on the archive's ETag, so a stale working copy
  cannot silently clobber remote history.
- `pull` refuses to overwrite a locally-born database (no recorded ETag), so
  the remote cannot silently clobber local history either.

## Configuration

Config via env vars (`src/config.ts` loads `.env` automatically; real
environment variables win): `WORKSPACE`, `KEEP_RAW`, `PAGE_SIZE`,
`FETCH_CONCURRENCY`, `FETCH_RETRIES`, `FETCH_TIMEOUT_MS`,
`MIN_SNAPSHOT_RATIO`, `ALLOW_SHRINK`, `LOG_LEVEL`, `MOA_SERVICE_URL`, and the
`R2_*` variables in `.env.example`.
