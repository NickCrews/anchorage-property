# anchorage-parcel-lake

The Municipality of Anchorage property database as a **public DuckDB
database** — every parcel's owner, appraised values, exemptions, zoning,
legal description, and geometry, updated daily, with a full **history
trail**: you can ask who owned any parcel, and what it was worth, at any
point in time since the archive started.

Anyone can query it over HTTPS with no credentials, no account, no API key,
no extension to install — just DuckDB (any version ≥ 1.0).

## Quick start

```sql
ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage.duckdb' AS lake (READ_ONLY);
--or, smaller download, see below: ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage-current.duckdb' AS lake (READ_ONLY);
SELECT count(*) FROM lake.parcels_current;
```

That's it. DuckDB range-reads the file straight from the bucket over HTTPS,
fetching only the columns your query touches (a typical query costs ~2–3 MB,
no matter how large the archive grows).

## The two published files

- **`anchorage.duckdb`** — the full archive: complete SCD2 history, geometry
  included. Use this from the DuckDB CLI, Python, or anything that can
  range-read over HTTPS.
- **`anchorage-current.duckdb`** — the browser file: current rows only, no
  polygon geometry (`geom_wkb`) and no internal `attr_hash`, but parcel
  centroids (`centroid_lon` / `centroid_lat`, EPSG:4326) so browser clients
  can still map parcels; ~23 MB. Browser clients
  ([shell.duckdb.org](https://shell.duckdb.org), duckdb-wasm, Pyodide/marimo)
  download whatever file they attach *in full* — they never range-read — so
  this file exists to keep that download small, and it does not grow as
  history accumulates.

## The parcel explorer app

[`app/`](app/) is a browser data app for exploring the dataset — a
[SQLRooms](https://sqlrooms.org/) room with a deck.gl parcel map, cross-filtered
[Mosaic](https://idl.uw.edu/mosaic/) charts, a profiler table, and a SQL
editor, all running on duckdb-wasm with no backend. It attaches the browser
file above and copies it into memory once; every interaction after that is a
local query.

```sh
pnpm run app   # dev server against workspaces/<WORKSPACE>/anchorage-current.duckdb
```

Production builds (`pnpm --dir app build`) read the published browser file
instead.

## What's in the archive

- **`lake.parcels_current`** — one row per parcel (~98.5k), the current state.
- **`lake.parcels`** — the full SCD2 history: one row per parcel *version*.
  A new version row is created only when something actually changed. Columns:
  - All the CAMA metadata: `owner_name`, `parcel_address`, appraised
    land/building/total value, exemptions, `taxable_value`, legal description,
    deed references, zoning, ...
  - `geom_wkb` — parcel geometry, WKB, EPSG:4326
  - `area_m2` — geodesically honest area (computed in EPSG:3338 Alaska Albers;
    Web-Mercator areas are ~4× inflated at 61°N)
  - `valid_from` / `valid_to` / `is_current` — the validity interval of this
    version (`valid_to IS NULL` means current)
- **`lake.ingest_runs`** — one row per ingest run: counts of new / changed /
  retired / unchanged parcels.

The browser file carries `parcels_current` (minus `geom_wkb` and `attr_hash`)
and `ingest_runs`, but not the `parcels` history table.

Multi-part parcels (one `Parcel_ID`, several source polygons) are collapsed to
one row per parcel with their geometries unioned; `feature_count` records how
many source features merged.

All timestamps are naive UTC.

## Example queries

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

Is a parcel in Girdwood or the rest of the muni? Tax district `4` is the
Girdwood Valley Service Area, which also catches the ~290 Girdwood parcels
with no site address (`gis_site_city IS NULL`, mostly vacant land):

```sql
SELECT parcel_id, parcel_address,
  CASE WHEN tax_district = '4' THEN 'Girdwood' ELSE 'Rest of the Muni' END AS area
FROM lake.parcels_current;
```

Is a parcel residential? `property_type` is the appraisal grouping and is
always exactly `'Residential'` or `'Commercial'`; use `land_use` when you
need finer grain (single-family, condo, duplex, ...):

Exemptions live in four (type, amount) slot pairs — the muni numbers them
1, 2, 5, 6 (3 and 4 don't exist). Slots 1–2 are institutional exemptions
(government / religious / charitable / non-profit ownership, with `- LAND`
variants when only the land is exempt), slot 5 is the personal ones (senior
citizen, disabled veteran, military widow(er)), slot 6 is only ever
`'OWNERS PRIMARY RESIDENCE'`, and `total_exemptions` is exactly their sum.
Exemptions are what separates appraised from taxable: `taxable_value` is
exactly `appraised_total_value - total_exemptions`. A zero difference is
stored two distinct ways, and the distinction is meaningful: NULL means the
parcel is *unvalued* (no appraisal, no exemptions — rights-of-way, condo
master records), while an explicit 0 means *valued but fully exempted*
(appraised > 0, entirely offset by exemptions). It also goes negative on a
handful of over-exempted parcels. Meanwhile
`net_taxable_value` floors it at zero but on ~0.1% of (often high-value)
parcels carries a tax-roll number the other columns can't reproduce — prefer
`taxable_value` when relating values to exemptions.
The full catalog of observed values, and the column semantics, are documented
in [src/exemptions.ts](src/exemptions.ts) and enforced by the data-quality
audit ([src/checks.ts](src/checks.ts)). Query the slot columns, not `exemption_types_all`
(a lossy upstream concatenation, truncated at 100 characters) and not
`exemption_type_group` (only ever `'Other'` / `'No Exemptions'`). For
example, every senior-exempt parcel:

```sql
SELECT parcel_id, parcel_address, exemption_5_amount
FROM lake.parcels_current
WHERE exemption_5_type LIKE 'SENIOR%';
```

Who owns a parcel? Some exemptions can only be granted to a particular kind
of owner, and the archive ships that labeling rule as an `exemptions` schema:
rules tables (`exemptions.owner_identifying`, `exemptions.use_identifying`)
plus a table macro that labels ~52% of parcels as
government/native_corp/nonprofit/hoa/person and abstains (NULL, with a
`basis` saying why) on the rest — see
[notebooks/owner_type_from_exemptions.py](notebooks/owner_type_from_exemptions.py)
for the evidence behind it:

```sql
SELECT parcel_id, owner_name, owner_type, basis
FROM lake.exemptions.categorize_by_exemption('lake.parcels_current');
```

Spatial — parcels within 500 m of a point, with owner (needs `LOAD spatial`;
geometry lives in the full archive, not the browser file):

```sql
LOAD spatial;
SELECT parcel_id, owner_name, parcel_address, round(area_m2) AS m2
FROM lake.parcels_current
WHERE ST_DWithin(
  ST_Transform(ST_GeomFromWKB(geom_wkb), 'EPSG:4326', 'EPSG:3338', always_xy := true),
  ST_Transform(ST_Point(-149.8997, 61.2176), 'EPSG:4326', 'EPSG:3338', always_xy := true),
  500);
```

## Data source

The Municipality of Anchorage publishes an official ArcGIS Feature Service,
[`PropertyInformation_Hosted`](https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0)
("parcel boundaries merged with Property Appraisal CAMA information, updated
daily except weekends"). A daily scraper pages through it and SCD2-merges the
snapshot into the archive; the history starts at its first ingest (early July 2026),
not at the beginning of MOA's records.

~1k source features with an empty `Parcel_ID` and all-null attributes
(uncatalogued geometry slivers with no CAMA record) are dropped — they cannot
be keyed. `PUBDATE` is stored but excluded from change detection, so the
nightly republish never creates spurious history versions.

A 42-check data-quality audit gates every publish — nothing ships until the
error-severity checks pass (no duplicate current rows, no overlapping
validity intervals, no missing geometry, values non-negative, parcels within
the Anchorage bbox, freshness, browser file in sync with the archive, ...). A few known real-world warts exist in the source
and are allowed through: a couple of ~1 m² sliver parcels and a few
OGC-invalid rings.

## Notes & caveats

- **Nothing to install, no version floor.** Both files are written at DuckDB
  storage version `v1.0.0`, so any DuckDB ≥ 1.0 opens them; `httpfs`
  autoloads for `https://` paths.
- The two files are published as separate objects, so during the daily
  refresh (~06:00 Anchorage) they can briefly disagree with each other.
- **Time travel is the explicit SCD2 columns.** `valid_from` / `valid_to` /
  `is_current` answer every "as of" question, as in the examples above.
- This is a read-only mirror with history, not the system of record. For
  authoritative data, go to the
  [MOA property database](https://property.muni.org/).

## Contributing

Want to run the pipeline yourself, develop on it, or publish your own copy?
See [CONTRIBUTING.md](CONTRIBUTING.md).
