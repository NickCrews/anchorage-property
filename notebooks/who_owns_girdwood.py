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
"""Who owns Girdwood? The primary-residence exemption as an owner-occupancy lens.

Compares the rate and amount of the 'OWNERS PRIMARY RESIDENCE' exemption
(slot 6) between Girdwood and the rest of the Municipality of Anchorage,
then asks where the owners of the *non*-exempt homes live. Queries the
public anchorage-parcel-lake DuckLake directly over HTTPS.

Run with:  uvx marimo edit --sandbox notebooks/who_owns_girdwood.py
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
    # Who owns Girdwood?

    The muni's residential exemption, `OWNERS PRIMARY RESIDENCE` (exemption
    slot 6), is granted only when the owner applies and attests the home is
    their primary residence. Its *rate* is therefore a rough proxy for
    owner-occupancy — homes without it are some mix of second homes,
    rentals, and investment property (plus owner-occupants who never
    applied, so read every rate here as a lower bound on occupancy).

    **"In Girdwood"** means tax district `4`, the Girdwood Valley Service
    Area. To keep the denominator honest, "homes" here means residential
    parcels with a structure (`property_type = 'Residential'` and
    `appraised_building_value > 0`) — Girdwood has a lot of vacant
    residential land that could never qualify for the exemption.
    """)
    return


@app.cell
def _(alt, duckdb):
    con = duckdb.connect()
    con.execute("INSTALL ducklake;")
    con.execute(
        "ATTACH 'ducklake:https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/catalog.ducklake'"
        " AS lake (READ_ONLY);"
    )

    AREA_CASE = "CASE WHEN tax_district = '4' THEN 'Girdwood' ELSE 'Rest of the Muni' END"
    # Residential parcels that actually have a dwelling on them.
    IS_HOME = "property_type = 'Residential' AND appraised_building_value > 0"
    # Slot 6 holds only this one type (see src/exemptions.ts), but match it
    # explicitly rather than relying on IS NOT NULL.
    HAS_PRE = "exemption_6_type = 'OWNERS PRIMARY RESIDENCE'"

    # Same emphasis palette as girdwood_vs_anchorage.py: Girdwood is the
    # subject (accent blue), the rest of the muni is context (gray).
    # Colors follow the entity, never the filter state.
    AREAS = ["Girdwood", "Rest of the Muni"]
    AREA_COLORS = ["#2a78d6", "#898781"]

    def area_color():
        return alt.Color(
            "area:N",
            title=None,
            scale=alt.Scale(domain=AREAS, range=AREA_COLORS),
            legend=alt.Legend(orient="top"),
        )

    return AREA_CASE, HAS_PRE, IS_HOME, area_color, con


@app.cell
def _(AREA_CASE, HAS_PRE, IS_HOME, con, mo, pl):
    _stats = con.execute(
        f"""
        SELECT
          {AREA_CASE} AS area,
          count(*) AS homes,
          count(*) FILTER ({HAS_PRE}) AS exempt_homes,
          count(*) FILTER ({HAS_PRE})::DOUBLE / count(*) AS rate,
          median(exemption_6_amount) FILTER ({HAS_PRE}) AS median_amount,
          sum(exemption_6_amount) FILTER ({HAS_PRE}) AS total_amount
        FROM lake.parcels_current
        WHERE {IS_HOME}
        GROUP BY 1
        ORDER BY 1
        """
    ).pl()
    _g = _stats.filter(pl.col("area") == "Girdwood").row(0, named=True)
    _r = _stats.filter(pl.col("area") == "Rest of the Muni").row(0, named=True)

    mo.hstack(
        [
            mo.stat(
                value=f"{_g['rate']:.1%}",
                label="Girdwood homes with the exemption",
                caption=f"{_r['rate']:.1%} in the rest of the muni",
                bordered=True,
            ),
            mo.stat(
                value=f"{_g['exempt_homes']:,} of {_g['homes']:,}",
                label="Exempt homes / all homes",
                caption=f"{_r['exempt_homes']:,} of {_r['homes']:,} in the rest of the muni",
                bordered=True,
            ),
            mo.stat(
                value=f"${_g['median_amount']:,.0f}",
                label="Median exemption amount",
                caption=f"${_r['median_amount']:,.0f} in the rest of the muni",
                bordered=True,
            ),
            mo.stat(
                value=f"${_g['total_amount'] / 1e6:,.1f}M",
                label="Total value exempted",
                caption=f"${_r['total_amount'] / 1e6:,.1f}M in the rest of the muni",
                bordered=True,
            ),
        ],
        widths="equal",
    )
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## How big is the exemption where it exists?

    Share of each area's *exempt* homes by exemption amount, in \$5k bins.
    The exemption is a percentage of appraised value up to a cap, and both
    halves of that formula should be visible here: a ramp that tracks home
    values, then a pile-up in the top bin where the cap binds. If Girdwood's
    exempt homes are worth more, they should hit the cap more often.
    """)
    return


@app.cell
def _(AREA_CASE, HAS_PRE, IS_HOME, alt, area_color, con, mo):
    _df = con.execute(
        f"""
        WITH binned AS (
          SELECT
            {AREA_CASE} AS area,
            floor(exemption_6_amount / 5000) * 5000 AS bin_lo
          FROM lake.parcels_current
          WHERE {IS_HOME} AND {HAS_PRE}
        )
        SELECT area, bin_lo, count(*) AS n,
               count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY area) AS share
        FROM binned
        GROUP BY area, bin_lo
        ORDER BY area, bin_lo
        """
    ).pl()

    _y = alt.Y(
        "share:Q",
        stack=None,
        title="Share of area's exempt homes",
        axis=alt.Axis(format=".0%"),
    )
    _base = alt.Chart(_df).encode(
        x=alt.X("bin_lo:Q", title="Exemption amount", axis=alt.Axis(format="$~s")),
        y=_y,
        color=area_color(),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("bin_lo:Q", title="Bin start", format="$,.0f"),
            alt.Tooltip("n:Q", title="Homes", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    )
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
    (_behind + _front).properties(width="container", height=300)
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Does owner-occupancy fall as homes get pricier?

    Exemption rate by appraised total value, in \$200k bins (values above
    \$2M lumped into the top bin). If Girdwood's expensive homes are
    disproportionately second homes, its curve should sag below the rest of
    the muni's as value rises. Girdwood's bins are small — hover for the
    home count before trusting a wiggle.
    """)
    return


@app.cell
def _(AREA_CASE, HAS_PRE, IS_HOME, alt, area_color, con):
    _df = con.execute(
        f"""
        SELECT
          {AREA_CASE} AS area,
          least(floor(appraised_total_value / 200000) * 200000, 2000000) AS bin_lo,
          count(*) AS n,
          count(*) FILTER ({HAS_PRE})::DOUBLE / count(*) AS rate
        FROM lake.parcels_current
        WHERE {IS_HOME}
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).pl()

    alt.Chart(_df).mark_line(point=True, strokeWidth=2.5).encode(
        x=alt.X("bin_lo:Q", title="Appraised total value", axis=alt.Axis(format="$~s")),
        y=alt.Y(
            "rate:Q",
            title="Share of homes with the exemption",
            axis=alt.Axis(format=".0%"),
            scale=alt.Scale(domain=[0, 1]),
        ),
        color=area_color(),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("bin_lo:Q", title="Bin start", format="$,.0f"),
            alt.Tooltip("n:Q", title="Homes in bin", format=","),
            alt.Tooltip("rate:Q", title="Exemption rate", format=".1%"),
        ],
    ).properties(width="container", height=300)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Who owns the homes that aren't primary residences?

    For homes *without* the exemption, where does the tax bill go?
    Buckets come from the owner's mailing address: a `99587` zip is
    Girdwood itself, otherwise `owner_state` splits Alaska from Outside.
    An in-Girdwood owner without the exemption may still be a local
    (landlord, recent buyer, or never applied); an Outside address is a
    much stronger second-home signal.
    """)
    return


@app.cell
def _(AREA_CASE, HAS_PRE, IS_HOME, alt, area_color, con, mo):
    _df = con.execute(
        f"""
        WITH owners AS (
          SELECT
            {AREA_CASE} AS area,
            CASE
              WHEN owner_zip LIKE '99587%' THEN 'Girdwood'
              WHEN upper(trim(owner_state)) = 'AK' THEN 'Elsewhere in Alaska'
              WHEN owner_state IS NULL OR trim(owner_state) = '' THEN 'Unknown'
              ELSE 'Outside Alaska'
            END AS owner_home
          FROM lake.parcels_current
          WHERE {IS_HOME} AND NOT coalesce({HAS_PRE}, FALSE)
        )
        SELECT area, owner_home, count(*) AS n,
               count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY area) AS share
        FROM owners
        GROUP BY area, owner_home
        ORDER BY area, n DESC
        """
    ).pl()

    _order = ["Girdwood", "Elsewhere in Alaska", "Outside Alaska", "Unknown"]
    _chart = alt.Chart(_df).mark_bar(cornerRadiusEnd=4).encode(
        y=alt.Y("owner_home:N", title="Owner's mailing address", sort=_order),
        x=alt.X(
            "share:Q",
            title="Share of area's non-exempt homes",
            axis=alt.Axis(format=".0%"),
        ),
        color=area_color(),
        yOffset=alt.YOffset("area:N", sort=["Girdwood", "Rest of the Muni"]),
        tooltip=[
            alt.Tooltip("area:N", title="Area"),
            alt.Tooltip("owner_home:N", title="Owner's mailing address"),
            alt.Tooltip("n:Q", title="Homes", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    ).properties(width="container", height=260)

    mo.vstack([_chart])
    return


@app.cell
def _(mo):
    mo.md("""
    ### Where exactly? Top owner cities for Girdwood's non-exempt homes

    The mailing cities behind Girdwood's non-primary-residence homes,
    most common first.
    """)
    return


@app.cell
def _(HAS_PRE, IS_HOME, con):
    con.execute(
        f"""
        SELECT
          coalesce(upper(trim(owner_city)), 'UNKNOWN') AS owner_city,
          coalesce(upper(trim(owner_state)), '?') AS owner_state,
          count(*) AS homes
        FROM lake.parcels_current
        WHERE tax_district = '4'
          AND {IS_HOME}
          AND NOT coalesce({HAS_PRE}, FALSE)
        GROUP BY 1, 2
        ORDER BY homes DESC
        LIMIT 15
        """
    ).pl()
    return


@app.cell
def _(mo):
    mo.md("""
    ## Where this could go next

    - **Trend over time**: the lake keeps SCD2 history — has Girdwood's
      exemption rate been falling as prices rose?
    - **Cross owners with parcels**: owners of multiple Girdwood homes
      (via `owner_name` / mailing address) are likely operators, not
      second-home owners.
    - **Condos vs houses**: split the rate by `land_use` — Girdwood's
      condo stock near the resort probably drives much of the gap.
    """)
    return


if __name__ == "__main__":
    app.run()
