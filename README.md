# anchorage-parcel-lake

The Municipality of Anchorage property database as a **public
[DuckLake](https://ducklake.select/)** — every parcel's owner, appraised
values, exemptions, zoning, legal description, and geometry, updated daily,
with a full **history trail**: you can ask who owned any parcel, and what it
was worth, at any point in time since the lake started.

Anyone can query it over HTTPS with no credentials, no account, no API key —
just DuckDB.

## Quick start

```sql
INSTALL ducklake;
ATTACH 'ducklake:https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/catalog.ducklake' AS lake;

SELECT count(*) FROM lake.parcels_current;
```

That's it. DuckDB fetches the catalog and reads the parquet files straight
from the bucket over HTTPS.

## What's in the lake

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

Spatial — parcels within 500 m of a point, with owner (needs `LOAD spatial`):

```sql
LOAD spatial;
SELECT parcel_id, owner_name, parcel_address, round(area_m2) AS m2
FROM lake.parcels_current
WHERE ST_DWithin(
  ST_Transform(ST_GeomFromWKB(geom_wkb), 'EPSG:4326', 'EPSG:3338', always_xy := true),
  ST_Transform(ST_Point(-149.8997, 61.2176), 'EPSG:4326', 'EPSG:3338', always_xy := true),
  500);
```

On top of the explicit SCD2 trail, DuckLake itself snapshots every committed
transaction, so `SELECT * FROM lake.parcels AT (VERSION => n)` time travel
also works as a second, physical audit layer.

## Data source

The Municipality of Anchorage publishes an official ArcGIS Feature Service,
[`PropertyInformation_Hosted`](https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/PropertyInformation_Hosted/FeatureServer/0)
("parcel boundaries merged with Property Appraisal CAMA information, updated
daily except weekends"). A daily scraper pages through it and SCD2-merges the
snapshot into this lake; the lake's history starts at its first ingest, not at
the beginning of MOA's records.

~1k source features with an empty `Parcel_ID` and all-null attributes
(uncatalogued geometry slivers with no CAMA record) are dropped — they cannot
be keyed. `PUBDATE` is stored but excluded from change detection, so the
nightly republish never creates spurious history versions.

A 22-check data-quality suite runs after every ingest (no duplicate current
rows, no overlapping validity intervals, no missing geometry, values
non-negative, parcels within the Anchorage bbox, freshness, ...). A few
known real-world warts exist in the source and are allowed through: a couple
of ~1 m² sliver parcels and a few OGC-invalid rings.

## Notes & caveats

- The lake is written with **DuckLake 1.0**, so reading it needs a DuckDB
  with the DuckLake 1.0 extension (DuckDB **1.5.2 or newer**). On an older
  install, `UPDATE EXTENSIONS;` or `FORCE INSTALL ducklake;` first.
- Browser-based clients (e.g. [shell.duckdb.org](https://shell.duckdb.org))
  work too: the bucket serves a CORS policy allowing `GET` from any origin.
- This is a read-only mirror with history, not the system of record. For
  authoritative data, go to the
  [MOA property database](https://property.muni.org/).

## Contributing

Want to run the pipeline yourself, develop on it, or publish your own copy?
See [CONTRIBUTING.md](CONTRIBUTING.md).
