# Anchorage Parcel Explorer

A free, interactive map of every property parcel in the Municipality of
Anchorage — who owns it, what it's appraised at, what it's taxed on, and when
it was built — refreshed daily from the muni's own property records.

**→ [Open the explorer](https://nickcrews.github.io/anchorage-property/)**

No account, nothing to install. Your first visit downloads about 36 MB of
data, so give it a moment on a slow connection; after that everything runs
right in your browser.

## What you can do

- **See the whole muni at once.** Use the *Color by* menu on the map to shade
  every parcel by appraised value (total, land, or building), taxable value,
  year built, or property type.
- **Look up a parcel.** Hover over one to see its address, owner, property
  type, and appraised value.
- **Filter with the charts.** Drag across the appraised value, year built, or
  deed date charts — or draw a box on the land-vs-building chart — to narrow
  things down. The other charts and the parcel table update to match.
- **Focus on one area.** Turn on *Spotlight filter* on the map, then move your
  mouse around: everything narrows to the parcels within the radius you pick.
- **Read the details.** The *Parcels* table under the map lists every
  matching parcel with its owner, land use, zoning, values, exemptions, year
  built, deed date, and lot size.

## Can't find what you're looking for?

The data behind the explorer holds more than the app shows: every exemption,
legal descriptions, parcel boundaries, and a history of every change to every
parcel — new owners, new values — since July 2026.

The easiest way in is to ask an AI assistant (Claude, ChatGPT, …) something
like:

> Using github.com/NickCrews/anchorage-property, which Girdwood parcels
> changed owners in the last three months?

It can fetch the data and answer for you. If you'd rather write the queries
yourself, see [DATABASE.md](DATABASE.md).

## Where the data comes from

Everything comes from the Municipality of Anchorage's public property records
— the same information you can look up one parcel at a time on
[property.muni.org](https://property.muni.org/). A fresh copy is taken every
day; the muni updates its records on weekdays.

A few things to keep in mind:

- **This is an unofficial copy.** For anything that matters — a tax bill, an
  appeal, a sale — check the parcel on
  [property.muni.org](https://property.muni.org/).
- **History starts in July 2026**, when this project began. Changes before
  then aren't recorded here.

## For data people and developers

- **Query the data directly** with SQL, including the full ownership and
  value history → [DATABASE.md](DATABASE.md)
- **Run the pipeline or work on the app** → [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE).
