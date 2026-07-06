# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "duckdb>=1.5.2",
#     "altair>=5.4",
#     "polars>=1.10",
#     "pyarrow>=17",
# ]
# ///
"""Girdwood vs the rest of the Municipality of Anchorage.

Explores parcel counts, appraised values, parcel sizes, and building ages,
querying the public anchorage-parcel-lake DuckLake directly over HTTPS.

Run with:  uvx marimo edit --sandbox notebooks/girdwood_vs_anchorage.py
"""

import marimo

__generated_with = "0.23.13"
app = marimo.App(width="medium")


@app.cell
def _():
    import altair as alt
    import duckdb
    import marimo as mo
    import polars as pl

    return alt, duckdb, mo, pl


@app.cell
def _(mo):
    mo.md("""
    # Girdwood vs the rest of the Muni

    **"In Girdwood"** here means tax district `4`, the Girdwood Valley
    Service Area. That boundary-based test also catches the ~290 Girdwood
    parcels with no site address (mostly vacant land).
    """)
    return


@app.cell
def _(alt, duckdb, mo):
    con = duckdb.connect()
    con.execute("INSTALL ducklake;")
    con.execute(
        "ATTACH 'ducklake:https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/catalog.ducklake'"
        " AS lake (READ_ONLY);"
    )

    # The two example classifications from the README.
    AREA_CASE = "CASE WHEN tax_district = '4' THEN 'Girdwood' ELSE 'Rest of the Muni' END"
    IS_RESIDENTIAL = "property_type = 'Residential'"

    # Emphasis palette: Girdwood is the subject (accent blue), the rest of the
    # muni is context (de-emphasis gray). Colors follow the entity, never the
    # filter state.
    AREAS = ["Girdwood", "Rest of the Muni"]
    AREA_COLORS = ["#2a78d6", "#898781"]

    def area_color():
        return alt.Color(
            "area:N",
            title=None,
            scale=alt.Scale(domain=AREAS, range=AREA_COLORS),
            legend=alt.Legend(orient="top"),
        )

    ptype = mo.ui.dropdown(
        options=["All", "Residential", "Commercial"],
        value="Residential",
        label="Property type",
    )
    return AREA_CASE, IS_RESIDENTIAL, area_color, con, ptype


@app.cell
def _(alt, area_color, mo):
    # The lake stores geodesic area_m2; the notebook displays acres.
    M2_PER_ACRE = 4046.8564224

    def area_overlay(df, x, tooltip, height=300):
        """Overlaid (not stacked) step-area comparison of the two areas.

        Explicit layering makes the relationship unambiguous: the rest of
        the muni sits behind as context (faint fill, dashed outline) and
        Girdwood is drawn in front (stronger fill, solid outline).
        fillOpacity keeps the outlines at full strength so crossings stay
        legible. stack=None matters: Altair stacks areas by default.
        """
        _y = alt.Y(
            "share:Q",
            stack=None,
            title="Share of area's parcels",
            axis=alt.Axis(format=".0%"),
        )
        _base = alt.Chart(df).encode(x=x, y=_y, color=area_color(), tooltip=tooltip)
        _behind = _base.transform_filter(
            alt.datum.area == "Rest of the Muni"
        ).mark_area(
            interpolate="step-after",
            fillOpacity=0.30,
            line={"strokeWidth": 2.5},
        )
        _front = _base.transform_filter(
            alt.datum.area == "Girdwood"
        ).mark_area(
            interpolate="step-after",
            fillOpacity=0.4,
            line={"strokeWidth": 2.5},
        )
        return (_behind + _front).properties(width="container", height=height)

    vtype = mo.ui.dropdown(
        options=["Land + structures", "Land only", "Structures only"],
        value="Land + structures",
        label="Value basis",
    )
    return M2_PER_ACRE, area_overlay, vtype


@app.cell
def _(IS_RESIDENTIAL, ptype, vtype):
    ptype_where = {
        "All": "TRUE",
        "Residential": IS_RESIDENTIAL,
        "Commercial": f"NOT ({IS_RESIDENTIAL})",
    }[ptype.value]


    value_col = {
        "Land + structures": "appraised_total_value",
        "Land only": "appraised_land_value",
        "Structures only": "appraised_building_value",
    }[vtype.value]
    return ptype_where, value_col


@app.cell
def _(
    AREA_CASE,
    M2_PER_ACRE,
    con,
    mo,
    pl,
    ptype,
    ptype_where,
    value_col,
    vtype,
):
    _stats = con.execute(
        f"""
        SELECT
          {AREA_CASE} AS area,
          count(*) AS parcels,
          median({value_col}) AS median_value,
          median(area_m2 / {M2_PER_ACRE}) AS median_acres,
          median(year_built_min) AS median_year_built
        FROM lake.parcels_current
        WHERE {ptype_where}
        GROUP BY 1
        ORDER BY 1
        """
    ).pl()
    _g = _stats.filter(pl.col("area") == "Girdwood").row(0, named=True)
    _r = _stats.filter(pl.col("area") == "Rest of the Muni").row(0, named=True)

    mo.vstack([
        mo.hstack([ptype, vtype], justify="start"),
    mo.hstack(
        [
            mo.stat(
                value=f"{_g['parcels']:,}",
                label=f"Girdwood parcels ({ptype.value.lower()})",
                caption=f"{_r['parcels']:,} in the rest of the muni",
                bordered=True,
            ),
            mo.stat(
                value=f"${_g['median_value']:,.0f}",
                label="Median appraised value",
                caption=f"${_r['median_value']:,.0f} in the rest of the muni",
                bordered=True,
            ),
            mo.stat(
                value=f"{_g['median_acres']:,.2f} acres",
                label="Median parcel area",
                caption=f"{_r['median_acres']:,.2f} acres in the rest of the muni",
                bordered=True,
            ),
            mo.stat(
                value=f"{_g['median_year_built']:.0f}",
                label="Median year built",
                caption=f"{_r['median_year_built']:.0f} in the rest of the muni",
                bordered=True,
            ),
        ],
        widths="equal",
    )
    ])
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Appraised value

    Share of each area's parcels by appraised value, in \$100k bins.
    Shares (not counts) because Girdwood's ~1.9k parcels would vanish next
    to the rest of the muni's ~97k. Values above \$2M are lumped into the
    top bin. The *Value basis* selector switches between land value,
    structure value, or their sum (the assessor's total is exactly
    land + structures).
    """)
    return


@app.cell
def _(
    AREA_CASE,
    alt,
    area_overlay,
    con,
    mo,
    ptype,
    ptype_where,
    value_col,
    vtype,
):
    _df = con.execute(
        f"""
        WITH binned AS (
          SELECT
            {AREA_CASE} AS area,
            least(floor({value_col} / 100000) * 100000, 2000000) AS bin_lo
          FROM lake.parcels_current
          WHERE {ptype_where} AND {value_col} > 0
        )
        SELECT area, bin_lo, count(*) AS n,
               count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY area) AS share
        FROM binned
        GROUP BY area, bin_lo
        ORDER BY area, bin_lo
        """
    ).pl()

    _chart = area_overlay(
        _df,
        x=alt.X("bin_lo:Q", title=f"Appraised value ({vtype.value.lower()})", axis=alt.Axis(format="$~s")),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("bin_lo:Q", title="Bin start", format="$,.0f"),
            alt.Tooltip("n:Q", title="Parcels", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    )

    mo.vstack([mo.hstack([ptype, vtype], justify="start"), _chart])
    return


@app.cell
def _(mo):
    mo.md("""
    ## Parcel size

    Parcel area on a log scale with quarter-decade bins.
    For reference: a typical Anchorage Bowl lot is ~0.17–0.25 acres.
    """)
    return


@app.cell
def _(AREA_CASE, M2_PER_ACRE, alt, area_overlay, con, mo, ptype, ptype_where):
    _df = con.execute(
        f"""
        WITH binned AS (
          SELECT
            {AREA_CASE} AS area,
            pow(10, floor(log10(area_m2 / {M2_PER_ACRE}) * 4) / 4) AS bin_lo
          FROM lake.parcels_current
          WHERE {ptype_where} AND area_m2 > 0
        )
        SELECT area, bin_lo, count(*) AS n,
               count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY area) AS share
        FROM binned
        GROUP BY area, bin_lo
        ORDER BY area, bin_lo
        """
    ).pl()

    _chart = area_overlay(
        _df,
        x=alt.X(
            "bin_lo:Q",
            title="Parcel area (acres, log scale)",
            scale=alt.Scale(type="log"),
            axis=alt.Axis(format=",.2~f"),
        ),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("bin_lo:Q", title="Bin start (acres)", format=",.3~f"),
            alt.Tooltip("n:Q", title="Parcels", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    )

    mo.vstack([ptype, _chart])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## Value per acre

    Appraised value (on the selected basis) divided by parcel area.
    This combines the two views above: a small,
    expensive lot and a huge, cheap one can have the same total value but
    very different value density. Parcels with no appraised value or no
    area are excluded.
    """)
    return


@app.cell
def _(
    AREA_CASE,
    M2_PER_ACRE,
    alt,
    area_overlay,
    con,
    mo,
    ptype,
    ptype_where,
    value_col,
    vtype,
):
    _df = con.execute(
        f"""
        WITH binned AS (
          SELECT
            {AREA_CASE} AS area,
            pow(
              10,
              floor(log10({value_col} / (area_m2 / {M2_PER_ACRE})) * 4) / 4
            ) AS bin_lo
          FROM lake.parcels_current
          WHERE {ptype_where} AND {value_col} > 0 AND area_m2 > 0
        )
        SELECT area, bin_lo, count(*) AS n,
               count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY area) AS share
        FROM binned
        GROUP BY area, bin_lo
        ORDER BY area, bin_lo
        """
    ).pl()

    _chart = area_overlay(
        _df,
        x=alt.X(
            "bin_lo:Q",
            title=f"Appraised value per acre ({vtype.value.lower()}, log scale)",
            scale=alt.Scale(type="log"),
            axis=alt.Axis(format="$~s"),
        ),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("bin_lo:Q", title="Bin start ($/acre)", format="$,.0f"),
            alt.Tooltip("n:Q", title="Parcels", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    )

    mo.vstack([mo.hstack([ptype, vtype], justify="start"), _chart])
    return


@app.cell
def _(mo):
    mo.md("""
    ## When was it built?

    Share of each area's parcels by decade of construction
    (`year_built_min`; parcels with no recorded year — mostly vacant land —
    are excluded).
    """)
    return


@app.cell
def _(AREA_CASE, alt, area_overlay, con, mo, ptype, ptype_where):
    _df = con.execute(
        f"""
        WITH binned AS (
          SELECT
            {AREA_CASE} AS area,
            (year_built_min // 10) * 10 AS decade
          FROM lake.parcels_current
          WHERE {ptype_where} AND year_built_min BETWEEN 1900 AND 2026
        )
        SELECT area, decade, count(*) AS n,
               count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY area) AS share
        FROM binned
        GROUP BY area, decade
        ORDER BY area, decade
        """
    ).pl()

    _chart = area_overlay(
        _df,
        x=alt.X("decade:Q", title="Decade built", axis=alt.Axis(format="d")),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("decade:Q", title="Decade", format="d"),
            alt.Tooltip("n:Q", title="Parcels", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    )

    mo.vstack([ptype, _chart])
    return


@app.cell
def _(mo):
    mo.md("""
    ## What kind of properties?

    Share of each area's parcels by land use, for the ten most common land
    uses muni-wide (within the selected property type).
    """)
    return


@app.cell
def _(AREA_CASE, alt, area_color, con, mo, ptype, ptype_where):
    _df = con.execute(
        f"""
        WITH counts AS (
          SELECT
            {AREA_CASE} AS area,
            coalesce(land_use, 'Unknown') AS land_use,
            count(*) AS n
          FROM lake.parcels_current
          WHERE {ptype_where}
          GROUP BY 1, 2
        ),
        shares AS (
          SELECT *, n::DOUBLE / sum(n) OVER (PARTITION BY area) AS share
          FROM counts
        ),
        top AS (
          SELECT land_use FROM shares GROUP BY 1 ORDER BY sum(n) DESC LIMIT 10
        )
        SELECT * FROM shares WHERE land_use IN (FROM top)
        ORDER BY n DESC
        """
    ).pl()

    _chart = alt.Chart(_df).mark_bar(cornerRadiusEnd=4).encode(
        y=alt.Y("land_use:N", title=None, sort="-x"),
        x=alt.X("share:Q", title="Share of area's parcels", axis=alt.Axis(format=".0%")),
        color=area_color(),
        yOffset=alt.YOffset("area:N", sort=["Girdwood", "Rest of the Muni"]),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("land_use:N", title="Land use"),
            alt.Tooltip("n:Q", title="Parcels", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    ).properties(width="container", height=380)

    mo.vstack([ptype, _chart])
    return


if __name__ == "__main__":
    app.run()
