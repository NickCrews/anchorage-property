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
"""Categorize parcel owners from the muni's exemption slots — the sure-fire half.

Slots 1-2 and 5-6 of `parcels_current` say things about a parcel that, for some
exemption types, can only be true of a particular kind of owner. The labeling
rule built on that observation ships *inside the lake itself*, as the
`exemptions` schema (rules tables + a `categorize_by_exemption` table macro),
created at ingest from src/exemptions.ts:

    SELECT parcel_id, owner_type, basis
    FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')

This notebook contains no implementation. It presents the shipped rule: what
each piece asserts, the evidence it rests on, and what it buys. The rule's
correctness is enforced elsewhere — code tests in test/exemptions.test.ts,
data audits in src/checks.ts (`pnpm run audit`).

Run with:  uvx marimo edit --sandbox notebooks/owner_type_from_exemptions.py
"""

import marimo

__generated_with = "0.23.13"
app = marimo.App(width="medium")

with app.setup:
    from pathlib import Path

    import altair as alt
    import duckdb
    import marimo as mo
    import polars as pl

    def sql_str(value: str) -> str:
        """Quote a Python string as a SQL string literal."""
        escaped = value.replace("'", "''")
        return f"'{escaped}'"


@app.cell
def _():
    mo.md(r"""
    # Owner type from exemptions

    The muni publishes four exemption slots per parcel. Some of the values in
    them are true *only of a particular kind of owner* — a religious
    organization exemption is granted to a religious organization; the owner's
    primary residence exemption is granted to a natural person who lives there.
    Those values are a labeling rule that needs no model.

    That rule ships inside the lake as the `exemptions` schema — two rules
    tables and a table-valued macro, generated at ingest from
    [src/exemptions.ts](../src/exemptions.ts). It labels about **52%** of
    parcels and abstains on the rest. The abstentions are the input to
    [owner_type_from_names.py](owner_type_from_names.py).

    The whole design principle is **abstain, never guess**: a NULL `owner_type`
    is a correct answer, a wrong `owner_type` is not.
    """)
    return


@app.cell
def _():
    # Prefer the workspace's working copy (fresher, and guaranteed to carry the
    # exemptions schema after a local ingest); fall back to the published lake.
    _local = Path(__file__).resolve().parent.parent / "workspaces" / "default" / "anchorage.duckdb"
    lake_source = (
        str(_local)
        if _local.exists()
        else "https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage.duckdb"
    )
    con = duckdb.connect()
    con.execute(f"ATTACH '{lake_source}' AS lake (READ_ONLY);")

    def q(sql: str) -> pl.DataFrame:
        return con.execute(sql).pl()

    mo.md(f"Reading `{lake_source}`")
    return con, q


@app.cell
def _():
    mo.md(r"""
    ## The four slots

    Per `src/exemptions.ts`, slots 3 and 4 do not exist upstream, and the four
    that do mean different things:

    - **Slots 1-2** hold institutional exemptions. Each type also occurs with a
      `" - LAND"` suffix when only the land portion is exempt. A building+land
      exemption fills both slots; a parcel with no building (vacant land) has a
      zero building-exemption amount, so **slot 1 is NULL and the exemption sits
      alone in slot 2**. Read `coalesce(exemption_1_type, exemption_2_type)`.
    - **Slot 5** holds the personal state-mandated exemptions: senior citizen,
      disabled veteran, military widow(er).
    - **Slot 6** holds only `OWNERS PRIMARY RESIDENCE`.
    """)
    return


@app.cell
def _(q):
    slots = q("""
        SELECT
          count(*)                                                     AS parcels,
          count(exemption_1_type)                                      AS slot_1_institutional,
          count(exemption_2_type)                                      AS slot_2_institutional_land,
          count(*) FILTER (exemption_1_type IS NULL
                       AND exemption_2_type IS NOT NULL)               AS slot_2_only,
          count(exemption_5_type)                                      AS slot_5_personal,
          count(exemption_6_type)                                      AS slot_6_residential,
          count(*) FILTER (
            exemption_1_type IS NULL AND exemption_2_type IS NULL
            AND exemption_5_type IS NULL AND exemption_6_type IS NULL) AS no_exemption_at_all
        FROM lake.parcels_current
    """)
    slots
    return


@app.cell
def _():
    mo.md(r"""
    306 parcels have slot 2 populated with slot 1 empty. Reading only slot 1
    would silently drop them into the no-exemption pool.

    ## Slots 1-2: owner-identifying vs. use-identifying

    The institutional catalog mixes two taxonomies, and only one of them says
    anything about the owner. The split ships as two rules tables:

    **`exemptions.owner_identifying`** — granted because of who you are.
    `MOA OWNED`, `RELIGIOUS ORG`, `NATIVE GROUPS / CORP OWNED`, and friends,
    each mapped to an owner type.

    **`exemptions.use_identifying`** — granted because of what the parcel is.
    `SUBDIVISION` is a builder's unsold-lot deferral; `COMMON AREA` attaches to
    the lot; `FARM USE` to the farming. The owner can be anyone, so the macro
    emits no label for these.
    """)
    return


@app.cell
def _(q):
    owner_identifying = q("""
        SELECT owner_type, count(*) AS bases, list(base ORDER BY base) AS exemption_bases
        FROM lake.exemptions.owner_identifying
        GROUP BY owner_type ORDER BY bases DESC
    """)
    owner_identifying
    return


@app.cell
def _(q):
    use_identifying = q("SELECT base FROM lake.exemptions.use_identifying ORDER BY base")
    use_identifying
    return


@app.cell
def _():
    mo.md(r"""
    The spot-check tool at the bottom is where each classification was tested;
    the evidence is summarized here.
    """)
    return


@app.cell
def _():
    evidence = pl.DataFrame(
        [
            ("SUBDIVISION", "use", "top owner HULTQUIST HOMES INC x92 — a builder holding unsold lots"),
            ("COMMON AREA", "use", "only ~26% HOA-named; also BLM, EKLUTNA INC, private persons"),
            ("DOWNTOWN RESI-DEV", "use", "12 of the top 20 owners are plainly individuals"),
            ("RIGHT-OF-WAY LAND", "use", "both parcels: EKLUTNA INC and PINE CREST HOMEOWNERS ASSOC"),
            ("DETERIORATED PROPS", "use", "owners are ordinary LLCs"),
            ("FARM USE (AMC 12.15)", "use", "owners are ordinary individuals"),
            ("CONDO DEVL MASTER RECORD", "use", "the one parcel is held by a revocable trust"),
            ("SPECIFIC TO CONDO PROJECT", "use", "n=5, mixed; too thin to label"),
            ("COMMUNITY / PUBLIC USE", "owner → nonprofit", "trade unions, Elks/Moose lodges, Providence — none are government"),
            ("NATIVE GROUPS / CORP OWNED", "owner → native_corp", "EKLUTNA INC holds 409/453; the residual ~15 are ANCSA allottees, i.e. persons"),
            ("STATE OWNED (EXC. SCHOOLS)", "owner → government", "apparent impurity is state corporations: AHFC, Alaska Railroad, U of A"),
            ("MOA OWNED (EXC. SCHOOLS)", "owner → government", "99% clean"),
        ],
        schema=["exemption_base", "verdict", "evidence"],
        orient="row",
    )
    evidence
    return


@app.cell
def _():
    mo.md(r"""
    `NATIVE GROUPS / CORP OWNED` is the one owner-identifying base with a known
    impurity: ~15 of 453 are ANCSA Native allotments, where the *land status*
    earns the exemption and the owner is a natural person. It stays in the map —
    97% precision on 0.5% of parcels — but it is the weakest entry.

    ## Slots 5-6: natural persons, with two guards

    Slot 5 (senior, disabled veteran, military widow(er)) and slot 6 (owner's
    primary residence) are statutorily restricted to natural persons occupying
    the property. Together they cover 51,420 parcels — the single largest signal
    in the table.

    They are not quite proof, because `owner_name` can contradict them:

    - **A trust name** (`SMITH FAMILY TRUST`) is *not* a contradiction — a trust
      may hold a primary residence — but whether that owner is a `person` is a
      taxonomy decision the muni's data cannot settle. Abstain.
    - **A corporate name** (`ACME RENTALS LLC` with `OWNERS PRIMARY RESIDENCE`)
      *is* a contradiction. 85 parcels. Stale owner name after a sale, or
      exemption fraud. Either way, abstain.

    Both guards only ever remove a label. That makes slot 6 imply `person` at
    about 99.8% precision rather than 100%.
    """)
    return


@app.cell
def _(q):
    person_slots = q("""
        SELECT 'slot 5 (personal)' AS slot, exemption_5_type AS type, count(*) AS n
        FROM lake.parcels_current WHERE exemption_5_type IS NOT NULL GROUP BY ALL
        UNION ALL
        SELECT 'slot 6 (residential)', exemption_6_type, count(*)
        FROM lake.parcels_current WHERE exemption_6_type IS NOT NULL GROUP BY ALL
        ORDER BY n DESC
    """)
    person_slots
    return


@app.cell
def _():
    mo.md(r"""
    ## The macro

    `exemptions.categorize_by_exemption(source_table)` takes the *name* of any
    table or view exposing `owner_name` and `exemption_{1,2,5,6}_type`, and
    returns every source column plus `owner_type` (the label, or NULL when it
    abstains) and `basis` (why, never NULL). Source columns pass through
    untouched, so the macro composes with any downstream query.

    Its body — as stored in the lake's catalog:
    """)
    return


@app.cell
def _(q):
    _definition = q("""
        SELECT macro_definition FROM duckdb_functions()
        WHERE database_name = 'lake' AND schema_name = 'exemptions'
          AND function_name = 'categorize_by_exemption'
    """)["macro_definition"][0]
    mo.md(f"```sql\n{_definition}\n```")
    return


@app.cell
def _():
    mo.md(r"""
    ## Where the guarantees live

    Everything above is an assumption that could quietly stop being true, so
    none of it is enforced here:

    - **Code tests** — `test/exemptions.test.ts` pins every branch of the rule
      against a golden fixture (the `" - LAND"` stripping, the NAVITE alias, the
      slot-2-only case, both name guards, the use-based refusal, the
      no-exemption default), and re-runs it through a re-opened database to
      prove the persisted macro survives any attachment alias. `pnpm test`.
    - **Data audits** — `src/checks.ts` checks the shipped rule against every
      parcel on every ingest: the macro's contract (row-preserving, `basis`
      vocabulary, `owner_type` NULL exactly when abstaining, the name guards
      one-directional) at error severity, and the upstream assumptions (every
      observed base classified, slots 1/2 always agreeing, and the load-bearing
      claim that no parcel carries both an owner-identifying and a personal
      exemption — so the two signals can never fight) at warn severity.
      `pnpm run audit`.

    ## Coverage

    What the rule actually buys, on all 98,519 parcels.
    """)
    return


@app.cell
def _(q):
    coverage = q("""
        SELECT
          basis,
          coalesce(owner_type, '— abstained —') AS owner_type,
          count(*) AS n,
          round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct
        FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
        GROUP BY ALL ORDER BY n DESC
    """)
    coverage
    return (coverage,)


@app.cell
def _(coverage):
    _plot = (
        alt.Chart(
            coverage.with_columns(
                labeled=pl.col("owner_type") != "— abstained —",
                bucket=pl.col("basis") + pl.lit(" → ") + pl.col("owner_type"),
            )
        )
        .mark_bar()
        .encode(
            x=alt.X("n:Q", title="parcels"),
            y=alt.Y("bucket:N", sort="-x", title=None),
            color=alt.Color("labeled:N", title="labeled"),
            tooltip=["bucket", "n", "pct"],
        )
        .properties(height=280)
    )
    mo.ui.altair_chart(_plot)
    return


@app.cell
def _(q):
    totals = q("""
        SELECT
          count(*) FILTER (owner_type IS NOT NULL) AS labeled,
          count(*) FILTER (owner_type IS NULL)     AS abstained,
          count(*)                                 AS total,
          round(100.0 * count(*) FILTER (owner_type IS NOT NULL) / count(*), 1) AS pct_labeled
        FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
    """)
    totals
    return


@app.cell
def _():
    mo.md(r"""
    | | parcels | share |
    |---|---:|---:|
    | `person` — slot 5/6, name clears both guards | 46,637 | 47.3% |
    | `government` | 2,938 | 3.0% |
    | `nonprofit` | 1,144 | 1.2% |
    | `native_corp` | 453 | 0.5% |
    | `hoa` | 38 | 0.0% |
    | **Labeled** | **51,210** | **52.0%** |
    | No exemption whatsoever | 42,093 | 42.7% |
    | Person exemption, trust-named | 4,698 | 4.8% |
    | Use-based exemption only | 433 | 0.4% |
    | Person exemption, corporate-named | 85 | 0.1% |
    | **Abstained** | **47,309** | **48.0%** |

    Two things worth naming. First, the labeled half is overwhelmingly the *easy*
    half: 91% of it is `person`. Second, `business` never appears — no exemption
    is granted for being a for-profit company, so exemptions cannot see a single
    rental LLC, absentee owner, or commercial holding. Those live entirely in the
    42,093 no-exemption parcels.

    That asymmetry sets up the evaluation problem for anything downstream: the
    labeled and abstained halves are not drawn from the same distribution. An
    owner-occupier with a senior exemption is not a random parcel, and the only
    place a non-`person` label is independently attested is the ~4,600
    institutional parcels.

    ## Spot-check any base

    The most common owner names per exemption base. This is what the mapping is
    asserting, and it is where the owner/use split above came from.
    """)
    return


@app.cell
def _(q):
    _bases = q("""
        SELECT DISTINCT lake.exemptions.institutional_base(
                 coalesce(exemption_1_type, exemption_2_type)) AS base
        FROM lake.parcels_current
        WHERE coalesce(exemption_1_type, exemption_2_type) IS NOT NULL ORDER BY 1
    """)["base"].to_list()
    base_picker = mo.ui.dropdown(
        options=_bases, value="SUBDIVISION", label="Exemption base to spot-check"
    )
    base_picker
    return (base_picker,)


@app.cell
def _(base_picker, q):
    _base = sql_str(base_picker.value)
    spot_check = q(f"""
        SELECT owner_name, count(*) AS parcels
        FROM lake.parcels_current
        WHERE lake.exemptions.institutional_base(
                coalesce(exemption_1_type, exemption_2_type)) = {_base}
        GROUP BY 1 ORDER BY parcels DESC, owner_name LIMIT 20
    """)
    spot_check
    return


@app.cell
def _():
    mo.md(r"""
    ## What's left

    47,309 parcels with no confident label, and the only evidence remaining is
    `owner_name` — a field with its own pathologies.
    [owner_type_from_names.py](owner_type_from_names.py) takes the abstentions
    from the same shipped macro, and starts there.
    """)
    return


if __name__ == "__main__":
    app.run()
