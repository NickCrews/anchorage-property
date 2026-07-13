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
public anchorage-parcel-lake DuckDB database directly over HTTPS.

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
    con.execute(
        "ATTACH 'https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage.duckdb'"
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
def _(AREA_CASE, HAS_PRE, IS_HOME, alt, area_color, con):
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
    ## Following the mail: hunting for the owner's primary residence

    A parcel's owner record carries a mailing address — where the tax bill
    goes. For a second home, that address is usually the owner's *primary*
    residence. So for each non-exempt Girdwood home we normalize the
    owner's mailing address (uppercase, strip punctuation and unit
    numbers, abbreviate STREET→ST, CIRCLE→CIR, …) and look for a muni
    parcel whose **site** address matches it. If that parcel is a home
    claiming the `OWNERS PRIMARY RESIDENCE` exemption, the loop closes:
    the owner told the assessor "I live *here*" — which proves the
    Girdwood house is not their primary residence, and pinpoints where
    they actually live.

    Two structural caveats. Girdwood has no home mail delivery, so a
    Girdwood PO box is itself a decent local signal — those owners likely
    live in Girdwood and simply never applied. And a few hundred owners
    are redacted upstream as `PROPERTY OWNER OF RECORD`; they are
    excluded from all identity matching below.
    """)
    return


@app.cell
def _(con):
    def _addr_norm(col):
        # Mailing addresses spell out STREET/CIRCLE/DRIVE; site addresses
        # abbreviate them. Normalize both to the abbreviated form.
        expr = f"regexp_replace(upper(trim(coalesce({col}, ''))), '[.,]', '', 'g')"
        expr = f"regexp_replace({expr}, '\\s+', ' ', 'g')"
        expr = f"regexp_replace({expr}, ' (APT|UNIT|STE|SUITE|#) ?[A-Z0-9-]+$', '')"
        for _long, _short in [
            ("STREET", "ST"), ("AVENUE", "AVE"), ("ROAD", "RD"),
            ("DRIVE", "DR"), ("LANE", "LN"), ("CIRCLE", "CIR"),
            ("COURT", "CT"), ("PLACE", "PL"), ("BOULEVARD", "BLVD"),
            ("HIGHWAY", "HWY"), ("PARKWAY", "PKWY"), ("TRAIL", "TRL"),
        ]:
            expr = f"regexp_replace({expr}, ' {_long}$| {_long} ', ' {_short} ')"
        return f"trim({expr})"

    # One normalized view all the linking queries share. `unlinkable` marks
    # parcels that can't participate in identity joins (redacted owner or
    # no mailing address).
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW linked AS
        SELECT
          parcel_id,
          tax_district,
          appraised_total_value,
          property_type = 'Residential' AND appraised_building_value > 0 AS is_home,
          coalesce(exemption_6_type = 'OWNERS PRIMARY RESIDENCE', FALSE) AS has_pre,
          {_addr_norm('parcel_address')} AS site_norm,
          {_addr_norm('owner_address')} AS mail_norm,
          substr(regexp_replace(coalesce(owner_zip, ''), '[^0-9]', '', 'g'), 1, 5) AS mail_zip5,
          substr(regexp_replace(coalesce(gis_site_zipcode, ''), '[^0-9]', '', 'g'), 1, 5) AS site_zip5,
          upper(trim(coalesce(owner_name, ''))) AS oname,
          upper(trim(coalesce(owner_city, ''))) AS ocity,
          upper(trim(coalesce(owner_state, ''))) AS ostate,
          oname = 'PROPERTY OWNER OF RECORD' OR oname = '' OR mail_norm = '' AS unlinkable
        FROM lake.parcels_current
    """)
    LINKED = "linked"

    MUNI_CITIES = (
        "('ANCHORAGE','EAGLE RIVER','CHUGIAK','GIRDWOOD','JBER','INDIAN',"
        "'BIRD CREEK','FORT RICHARDSON','ELMENDORF AFB','PETERS CREEK','EKLUTNA')"
    )
    return LINKED, MUNI_CITIES


@app.cell
def _(LINKED, MUNI_CITIES, con):
    # Where does each non-exempt Girdwood home's tax bill go?
    mail_trail_df = con.execute(f"""
        WITH gw AS (
          SELECT * FROM {LINKED} WHERE tax_district = '4' AND is_home AND NOT has_pre
        ),
        sites AS (
          SELECT site_norm, site_zip5, bool_or(has_pre) AS site_has_pre
          FROM {LINKED} WHERE site_norm != '' AND is_home
          GROUP BY 1, 2
        )
        SELECT
          CASE
            WHEN NOT regexp_matches(gw.mail_norm, '^\\d') THEN
              CASE WHEN gw.mail_zip5 = '99587' THEN 'PO box in Girdwood'
                   ELSE 'PO box / other non-street' END
            WHEN s.site_has_pre THEN 'An exempt muni home'
            WHEN s.site_norm IS NOT NULL THEN 'A muni home without the exemption'
            WHEN gw.ostate != 'AK' THEN 'A street address outside Alaska'
            WHEN gw.ocity NOT IN {MUNI_CITIES} THEN 'A street address in AK, outside the muni'
            ELSE 'In the muni, but no home matched'
          END AS mail_goes_to,
          count(*) AS n,
          count(*)::DOUBLE / sum(count(*)) OVER () AS share
        FROM gw LEFT JOIN sites s
          ON gw.mail_norm = s.site_norm AND gw.mail_zip5 = s.site_zip5
        GROUP BY 1 ORDER BY n DESC
    """).pl()
    return (mail_trail_df,)


@app.cell
def _(LINKED, con):
    # Per non-exempt Girdwood home: the owner's whole muni portfolio.
    # Two link types, unioned:
    #   strict    — parcels sharing the exact owner name + mailing address
    #   mail_home — the muni home standing at the owner's mailing address,
    #               regardless of title name (catches "SMITH JOHN & JANE"
    #               vs "SMITH JOHN" title variants)
    portfolios_df = con.execute(f"""
        WITH gw AS (
          SELECT * FROM {LINKED}
          WHERE tax_district = '4' AND is_home AND NOT has_pre AND NOT unlinkable
        ),
        strict AS (
          SELECT gw.parcel_id AS gw_parcel, o.parcel_id, o.is_home, o.has_pre,
                 o.appraised_total_value
          FROM gw JOIN {LINKED} o
            ON o.oname = gw.oname AND o.mail_norm = gw.mail_norm
               AND o.mail_zip5 = gw.mail_zip5
          WHERE NOT o.unlinkable
        ),
        mail_home AS (
          SELECT gw.parcel_id AS gw_parcel, o.parcel_id, o.is_home, o.has_pre,
                 o.appraised_total_value
          FROM gw JOIN {LINKED} o
            ON o.site_norm = gw.mail_norm AND o.site_zip5 = gw.mail_zip5
          WHERE o.is_home
        ),
        combined AS (
          SELECT DISTINCT ON (gw_parcel, parcel_id) * FROM (
            SELECT * FROM strict UNION ALL SELECT * FROM mail_home
          )
        )
        SELECT
          gw_parcel,
          count(*) FILTER (is_home) AS n_homes,
          count(*) AS n_parcels,
          sum(appraised_total_value) AS total_value,
          bool_or(has_pre) AS primary_found
        FROM combined
        GROUP BY 1
    """).pl()
    return (portfolios_df,)


@app.cell
def _(mail_trail_df, mo, pl, portfolios_df):
    _total = mail_trail_df["n"].sum()
    _verified_addr = mail_trail_df.filter(
        pl.col("mail_goes_to") == "An exempt muni home"
    )["n"].sum()
    _second_plus = portfolios_df.filter(pl.col("primary_found"))
    _third_plus = _second_plus.filter(pl.col("n_homes") >= 3)

    mo.hstack(
        [
            mo.stat(
                value=f"{_verified_addr / _total:.0%}",
                label="Tax bill goes to an exempt muni home",
                caption=f"{_verified_addr:,} of {_total:,} non-exempt Girdwood homes",
                bordered=True,
            ),
            mo.stat(
                value=f"{len(_second_plus):,}",
                label="Verified 2nd+ homes of muni households",
                caption="owner claims the exemption on another muni home",
                bordered=True,
            ),
            mo.stat(
                value=f"{len(_third_plus):,}",
                label="Actually a 3rd home (or beyond)",
                caption="owner holds 3+ muni homes incl. an exempt primary",
                bordered=True,
            ),
            mo.stat(
                value=f"${_second_plus['total_value'].median():,.0f}",
                label="Median muni portfolio, verified 2nd-homers",
                caption="all their muni parcels, appraised total",
                bordered=True,
            ),
        ],
        widths="equal",
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ### Where does the tax bill go?

    Each of Girdwood's non-exempt homes, classified by what stands at the
    owner's mailing address. The blue bar is the smoking gun: the mail
    goes to a muni home that itself claims the primary-residence
    exemption — the owner is a verified Anchorage-area resident and the
    Girdwood house is, at minimum, their second home. "No home matched"
    is mostly normalization residue (missing street types, condo units)
    plus commercial mail drops.
    """)
    return


@app.cell
def _(alt, mail_trail_df, mo):
    _chart = alt.Chart(mail_trail_df).mark_bar(cornerRadiusEnd=4).encode(
        y=alt.Y("mail_goes_to:N", title="Owner's mailing address is…", sort="-x"),
        x=alt.X("n:Q", title="Non-exempt Girdwood homes"),
        color=alt.condition(
            alt.datum.mail_goes_to == "An exempt muni home",
            alt.value("#2a78d6"),
            alt.value("#898781"),
        ),
        tooltip=[
            alt.Tooltip("mail_goes_to:N", title="Mailing address is"),
            alt.Tooltip("n:Q", title="Homes", format=","),
            alt.Tooltip("share:Q", title="Share", format=".1%"),
        ],
    ).properties(width="container", height=260)

    mo.vstack([_chart])
    return


@app.cell
def _(mo):
    mo.md("""
    ### Second home… or third, or seventeenth?

    For each non-exempt Girdwood home, the owner's full muni portfolio:
    every parcel sharing their exact name + mailing address, plus the
    home standing at their mailing address (which catches title variants
    like "SMITH JOHN & JANE" vs "SMITH JOHN"). Where the portfolio
    contains an exemption-claiming primary, we can rank the Girdwood
    house. The unit here is *homes*, not owners — one Eagle River LLC
    holds 17 Girdwood homes by itself, which is most of the "4th home or
    beyond" bar. "No exempt primary found" does not mean out-of-muni:
    it lumps together out-of-state owners, PO-box locals we can't link,
    and investors who claim no exemption anywhere.
    """)
    return


@app.cell
def _(alt, mo, pl, portfolios_df):
    _labeled = portfolios_df.with_columns(
        pl.when(~pl.col("primary_found"))
        .then(pl.lit("No exempt primary found in muni"))
        .when(pl.col("n_homes") == 2)
        .then(pl.lit("2nd home (primary + Girdwood)"))
        .when(pl.col("n_homes") == 3)
        .then(pl.lit("3rd home"))
        .otherwise(pl.lit("4th home or beyond"))
        .alias("outcome")
    )
    _df = _labeled.group_by("outcome").agg(
        pl.len().alias("n"),
        pl.col("total_value").median().alias("median_portfolio"),
    )

    _order = [
        "2nd home (primary + Girdwood)",
        "3rd home",
        "4th home or beyond",
        "No exempt primary found in muni",
    ]
    _chart = alt.Chart(_df).mark_bar(cornerRadiusEnd=4).encode(
        y=alt.Y("outcome:N", title=None, sort=_order),
        x=alt.X("n:Q", title="Non-exempt Girdwood homes"),
        color=alt.condition(
            alt.datum.outcome != "No exempt primary found in muni",
            alt.value("#2a78d6"),
            alt.value("#898781"),
        ),
        tooltip=[
            alt.Tooltip("outcome:N", title="Outcome"),
            alt.Tooltip("n:Q", title="Homes", format=","),
            alt.Tooltip("median_portfolio:Q", title="Median muni portfolio", format="$,.0f"),
        ],
    ).properties(width="container", height=200)

    mo.vstack([_chart])
    return


@app.cell
def _(mo):
    mo.md("""
    ### The biggest Girdwood second-home portfolios

    Owners of non-exempt Girdwood homes, ranked by the appraised total
    value of **everything** they hold in the muni under the same name and
    mailing address (land + structures, all property types). This is
    muni-only: a Wasilla mansion or a Seattle penthouse is invisible
    here, so out-of-muni owners' totals are floors. `primary_claimed`
    marks portfolios containing an exemption-claiming primary residence.
    """)
    return


@app.cell
def _(LINKED, con):
    con.execute(f"""
        WITH gw AS (
          SELECT DISTINCT oname, mail_norm, mail_zip5, ocity, ostate FROM {LINKED}
          WHERE tax_district = '4' AND is_home AND NOT has_pre AND NOT unlinkable
        ),
        port AS (
          SELECT gw.oname, gw.ocity, gw.ostate,
                 count(*) FILTER (o.is_home) AS homes,
                 count(*) AS parcels,
                 sum(o.appraised_total_value) AS total_value,
                 bool_or(o.has_pre) AS primary_claimed
          FROM gw JOIN {LINKED} o
            ON o.oname = gw.oname AND o.mail_norm = gw.mail_norm
               AND o.mail_zip5 = gw.mail_zip5
          WHERE NOT o.unlinkable
          GROUP BY 1, 2, 3
        )
        SELECT
          oname AS owner,
          ocity || ', ' || ostate AS mail_city,
          homes,
          parcels,
          format('${{:,}}', total_value::BIGINT) AS muni_total_value,
          CASE WHEN primary_claimed THEN 'yes' ELSE '' END AS primary_claimed
        FROM port ORDER BY total_value DESC LIMIT 20
    """).pl()
    return


@app.cell
def _(mo):
    mo.md("""
    ## Where this could go next

    - **Trend over time**: the lake keeps SCD2 history — has Girdwood's
      exemption rate been falling as prices rose?
    - **Condos vs houses**: split the rate by `land_use` — Girdwood's
      condo stock near the resort probably drives much of the gap.
    - **Fuzzier identity**: the strict name + mailing-address key misses
      owners who use different names or addresses across parcels
      (trusts, spouses, an LLC per property). Name-token matching or a
      shared-mailing-address household key (carefully — property
      managers' addresses collect hundreds of unrelated owners) would
      raise the link rate.
    - **The unmatched tail**: "in the muni, but no home matched" is
      ~11% — most of it is street-type quirks the normalizer misses
      (`1767 HAMILTON`, `1317 W NORTHERN LIGHTS`). Structured matching
      on the `gis_site_*` components could close it.
    """)
    return


if __name__ == "__main__":
    app.run()
