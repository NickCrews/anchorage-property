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
exemption types, can only be true of a particular kind of owner. This notebook
turns that into a labeling rule, proves the assumptions the rule rests on with
executable checks, and abstains everywhere the exemptions cannot settle the
question.

Exports
-------
    make_exemption_categorization_macro(duckdb_conn, macro_name)

Creates a table-valued macro in `duckdb_conn`, so callers can classify on demand:

    make_exemption_categorization_macro(con)
    con.sql("SELECT parcel_id, owner_type, basis FROM categorize_by_exemption('lake.parcels_current')")

Run with:  uvx marimo edit --sandbox notebooks/owner_type_from_exemptions.py
"""

import marimo

__generated_with = "0.23.13"
app = marimo.App(width="medium")

with app.setup:
    import altair as alt
    import duckdb
    import marimo as mo
    import polars as pl

    # The label vocabulary this notebook can produce. `person` comes from slots
    # 5/6; the rest from slots 1/2. Everything else is an abstention (NULL).
    CATEGORIES = ["government", "native_corp", "nonprofit", "hoa", "person"]

    # Slot 1-2 exemption bases (" - LAND" suffix stripped) that identify *who
    # owns* the parcel. You get these because of who you are.
    OWNER_IDENTIFYING: dict[str, str] = {
        "FEDERALLY OWNED": "government",
        "MOA OWNED (EXC. SCHOOLS)": "government",
        "MOA OWNED SCHOOLS": "government",
        "STATE OWNED (EXC. SCHOOLS)": "government",
        "STATE OWNED SCHOOL": "government",
        "NATIVE GROUPS / CORP OWNED": "native_corp",
        "RELIGIOUS ORG": "nonprofit",
        "RELIGIOUS HOUSING": "nonprofit",
        "CHARITABLE ORG / GROUPS": "nonprofit",
        "NON-PROFIT CEMETERY": "nonprofit",
        "NON-PROFIT EDUCATION": "nonprofit",
        "NON-PROFIT HOSPITALS": "nonprofit",
        "NON-PROFIT UTILITIES": "nonprofit",
        "NON-PROFIT VET ORG / CLUB": "nonprofit",
        "CHARTER SCHOOL": "nonprofit",
        "HOUSING AUTHORITY (NON-GOV)": "nonprofit",
        "COMMUNITY / PUBLIC USE": "nonprofit",
        "HOMEOWNERS ASSOC - OWN/USE": "hoa",
    }

    # Slot 1-2 bases that identify *what the parcel is or how it is used*. You
    # get these because of the land, and the owner can be anyone. Mapping these
    # to an owner type is a category error; the macro refuses to label them.
    USE_IDENTIFYING: list[str] = [
        "AFFORDABLE AND WORKFORCE HOUSING (AMC 12.70)",
        "COMMON AREA",
        "CONDO DEVL MASTER RECORD",
        "DETERIORATED PROPS",
        "DOWNTOWN RESI-DEV",
        "FARM USE (AMC 12.15)",
        "FARM/AGRICULTURAL (AS 29.45.060)",
        "RIGHT-OF-WAY LAND",
        "SPECIFIC TO CONDO PROJECT",
        "SUBDIVISION",
    ]

    # Slot 5-6 are statutorily restricted to natural persons, so they imply
    # `person` — unless the owner name says otherwise, in which case we abstain
    # rather than guess. Both guards are one-directional: they can only remove a
    # `person` label, never add one.
    TRUST_NAME_TOKEN = "TRUST"
    CORPORATE_NAME_PATTERN = r"(^| )(LLC|INC|CORP|LP|LTD)(\.|,|$| )"

    # The macro tags every row with why it did (or did not) get a label.
    LABELED_BASES = ["owner_identifying_exemption", "person_exemption"]
    ABSTAINED_BASES = [
        "person_exemption_trust_named",
        "person_exemption_corporate_named",
        "use_based_exemption_only",
        "no_exemption",
    ]


@app.cell
def _():
    mo.md(r"""
    # Owner type from exemptions

    The muni publishes four exemption slots per parcel. Some of the values in
    them are true *only of a particular kind of owner* — a religious
    organization exemption is granted to a religious organization; the owner's
    primary residence exemption is granted to a natural person who lives there.
    Those values are a labeling rule that needs no model.

    This notebook builds that rule, checks the assumptions it rests on against
    all 98,519 parcels, and exports it as a DuckDB macro. It labels about **52%**
    of parcels and abstains on the rest. The abstentions are the input to
    [owner_type_from_names.py](owner_type_from_names.py).

    The whole design principle is **abstain, never guess**: a NULL `owner_type`
    is a correct answer, a wrong `owner_type` is not.
    """)
    return


@app.cell
def _():
    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake;")
    con.execute(
        "ATTACH 'ducklake:https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/catalog.ducklake'"
        " AS lake (READ_ONLY);"
    )

    def q(sql: str) -> pl.DataFrame:
        return con.execute(sql).pl()

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

    `INSTITUTIONAL_EXEMPTION_BASES` mixes two taxonomies, and only one of them
    says anything about the owner.

    **Owner-identifying** — granted because of who you are. `MOA OWNED`,
    `RELIGIOUS ORG`, `NATIVE GROUPS / CORP OWNED`, and friends.

    **Use-identifying** — granted because of what the parcel is. `SUBDIVISION`
    is a builder's unsold-lot deferral; `COMMON AREA` attaches to the lot;
    `FARM USE` to the farming. The owner can be anyone, so the macro emits no
    label. The spot-check tool at the bottom is where each of these was tested;
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

    `owner_type` is the label or NULL; `basis` always says why. Source columns
    pass through untouched, so the macro composes with any downstream query.
    """)
    return


@app.function
def sql_str(value: str) -> str:
    """Quote a Python string as a SQL string literal."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


@app.function
def exemption_categorization_sql(macro_name: str = "categorize_by_exemption") -> str:
    """Render the CREATE MACRO statement. Pure; useful for tests and display."""
    cases = "\n            ".join(
        f"WHEN institutional_base = {sql_str(base)} THEN {sql_str(label)}"
        for base, label in OWNER_IDENTIFYING.items()
    )
    return f"""
CREATE OR REPLACE MACRO {macro_name}(source_table) AS TABLE
WITH normalized AS (
  SELECT
    *,
    -- Slot 2 carries the exemption alone on parcels with no building; the
    -- " - LAND" suffix marks a land-only exemption; NAVITE is the muni's own
    -- misspelling of NATIVE, faithfully preserved upstream.
    replace(
      regexp_replace(coalesce(exemption_1_type, exemption_2_type), ' - LAND$', ''),
      'NAVITE', 'NATIVE'
    )                                                     AS institutional_base,
    coalesce(exemption_5_type, exemption_6_type) IS NOT NULL AS has_person_exemption,
    contains(coalesce(owner_name, ''), {sql_str(TRUST_NAME_TOKEN)}) AS trust_named,
    regexp_matches(coalesce(owner_name, ''), {sql_str(CORPORATE_NAME_PATTERN)}) AS corporate_named
  FROM query_table(source_table)
), classified AS (
  SELECT *, CASE
            {cases}
            ELSE NULL
            END AS institutional_owner_type
  FROM normalized
)
SELECT
  * EXCLUDE (
    institutional_base, has_person_exemption, trust_named,
    corporate_named, institutional_owner_type
  ),
  CASE
    WHEN institutional_owner_type IS NOT NULL THEN institutional_owner_type
    WHEN has_person_exemption AND NOT trust_named AND NOT corporate_named THEN 'person'
  END AS owner_type,
  CASE
    WHEN institutional_owner_type IS NOT NULL       THEN 'owner_identifying_exemption'
    WHEN has_person_exemption AND trust_named       THEN 'person_exemption_trust_named'
    WHEN has_person_exemption AND corporate_named   THEN 'person_exemption_corporate_named'
    WHEN has_person_exemption                       THEN 'person_exemption'
    WHEN institutional_base IS NOT NULL             THEN 'use_based_exemption_only'
    ELSE                                                 'no_exemption'
  END AS basis
FROM classified
""".strip()


@app.function
def make_exemption_categorization_macro(
    duckdb_conn: duckdb.DuckDBPyConnection,
    macro_name: str = "categorize_by_exemption",
) -> str:
    """Create a table-valued macro that labels owner type from exemption slots.

    The macro takes one argument — the *name* of a source table or view, as a
    string — and returns every source column plus:

        owner_type  VARCHAR  one of CATEGORIES, or NULL when we abstain
        basis       VARCHAR  one of LABELED_BASES + ABSTAINED_BASES, never NULL

    The source must expose `owner_name` and `exemption_{1,2,5,6}_type`.

        make_exemption_categorization_macro(con)
        con.sql("FROM categorize_by_exemption('lake.parcels_current') WHERE owner_type IS NULL")

    Returns the macro name, for convenience.
    """
    duckdb_conn.execute(exemption_categorization_sql(macro_name))
    return macro_name


@app.cell
def _(con):
    macro = make_exemption_categorization_macro(con)
    mo.md(f"```sql\n{exemption_categorization_sql()}\n```")
    return (macro,)


@app.cell
def _():
    mo.md(r"""
    ## Checks

    Everything above is an assumption about upstream data that could quietly
    stop being true. Each check counts violating rows; every one must be zero.
    They run against all 98,519 parcels, so a new exemption value or a broken
    slot invariant fails this notebook rather than corrupting a label.
    """)
    return


@app.cell
def _(con):
    def check(checks: list[tuple[str, str]]) -> pl.DataFrame:
        """Run (description, violation-count SQL) pairs; assert all are zero."""
        rows = [
            {"check": name, "violations": con.execute(sql).fetchone()[0]}
            for name, sql in checks
        ]
        df = pl.DataFrame(rows).with_columns(passed=pl.col("violations") == 0)
        failed = df.filter(~pl.col("passed"))
        if len(failed):
            raise AssertionError(f"{len(failed)} check(s) failed:\n{failed}")
        return df

    return (check,)


@app.cell
def _():
    mo.md(r"""
    ### The upstream data model holds

    A slot's type is non-null exactly when its amount is nonzero; slots 1 and 2
    never name different exemptions; slots 5 and 6 draw from a closed vocabulary;
    every institutional base we see is one we have classified.
    """)
    return


@app.cell
def _(check):
    _known_bases = ", ".join(sql_str(b) for b in [*OWNER_IDENTIFYING, *USE_IDENTIFYING])
    _slot_5_vocab = """
        'SENIOR SELF: PRIMARY RESI', 'SENIOR: WIDOW(ER)',
        'DISABLED VET: SELF', 'DISABLED VET: WIDOW(ER)',
        'PERM DISABLED VET: SELF', 'PERM DISABLED VET: WIDOW(ER)',
        'MILITARY SERVICE: WIDOW(ER)', 'MILITARY SERVICE: WIDOW(ER) OTHER'
    """
    data_model_checks = check([
        (
            "slot type is non-null iff slot amount is nonzero",
            """SELECT count(*) FROM lake.parcels_current WHERE
                 (exemption_1_type IS NULL) != (coalesce(exemption_1_amount, 0) = 0)
              OR (exemption_2_type IS NULL) != (coalesce(exemption_2_amount, 0) = 0)
              OR (exemption_5_type IS NULL) != (coalesce(exemption_5_amount, 0) = 0)
              OR (exemption_6_type IS NULL) != (coalesce(exemption_6_amount, 0) = 0)""",
        ),
        (
            "slots 1 and 2 never name different exemption bases",
            """SELECT count(*) FROM lake.parcels_current
               WHERE exemption_1_type IS NOT NULL AND exemption_2_type IS NOT NULL
                 AND replace(regexp_replace(exemption_1_type, ' - LAND$', ''), 'NAVITE', 'NATIVE')
                  != replace(regexp_replace(exemption_2_type, ' - LAND$', ''), 'NAVITE', 'NATIVE')""",
        ),
        (
            "every institutional base is classified as owner- or use-identifying",
            f"""SELECT count(*) FROM lake.parcels_current
                WHERE coalesce(exemption_1_type, exemption_2_type) IS NOT NULL
                  AND replace(
                        regexp_replace(coalesce(exemption_1_type, exemption_2_type), ' - LAND$', ''),
                        'NAVITE', 'NATIVE')
                      NOT IN ({_known_bases})""",
        ),
        (
            "slot 5 draws only from the eight personal exemption types",
            f"""SELECT count(*) FROM lake.parcels_current
                WHERE exemption_5_type IS NOT NULL
                  AND exemption_5_type NOT IN ({_slot_5_vocab})""",
        ),
        (
            "slot 6 holds only OWNERS PRIMARY RESIDENCE",
            """SELECT count(*) FROM lake.parcels_current
               WHERE exemption_6_type IS NOT NULL
                 AND exemption_6_type != 'OWNERS PRIMARY RESIDENCE'""",
        ),
        (
            "owner_name is never NULL",
            "SELECT count(*) FROM lake.parcels_current WHERE owner_name IS NULL",
        ),
    ])
    data_model_checks
    return


@app.cell
def _():
    mo.md(r"""
    ### The exemptions never contradict each other

    This is the load-bearing claim. If a parcel could carry both an
    owner-identifying institutional exemption *and* a natural-person exemption,
    the two labels would fight and neither would be trustworthy. Not one parcel
    does.

    Nine parcels carry both a *use-based* exemption and a person exemption
    (`DOWNTOWN RESI-DEV` ×6, farm ×3). That is not a conflict — the use-based
    exemption makes no claim about the owner — and the macro resolves them to
    `person`, which the last check pins.
    """)
    return


@app.cell
def _(check, macro):
    _owner_bases = ", ".join(sql_str(b) for b in OWNER_IDENTIFYING)
    _base = """replace(regexp_replace(coalesce(exemption_1_type, exemption_2_type), ' - LAND$', ''),
                       'NAVITE', 'NATIVE')"""
    consistency_checks = check([
        (
            "no parcel has both an owner-identifying and a personal/residential exemption",
            f"""SELECT count(*) FROM lake.parcels_current
                WHERE {_base} IN ({_owner_bases})
                  AND coalesce(exemption_5_type, exemption_6_type) IS NOT NULL""",
        ),
        (
            "use-based + person exemption resolves to person, not use_based_exemption_only",
            f"""SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
                WHERE coalesce(exemption_1_type, exemption_2_type) IS NOT NULL
                  AND coalesce(exemption_5_type, exemption_6_type) IS NOT NULL
                  AND basis = 'use_based_exemption_only'""",
        ),
    ])
    consistency_checks
    return


@app.cell
def _():
    mo.md(r"""
    ### The macro's own contract

    One row out per row in, a `basis` on every row, a label drawn only from
    `CATEGORIES`, and `owner_type IS NULL` exactly when `basis` is an
    abstention. The two name guards must be one-directional: nothing labeled
    `person` may carry a trust or corporate token.
    """)
    return


@app.cell
def _(check, macro):
    _cats = ", ".join(sql_str(c) for c in CATEGORIES)
    _labeled = ", ".join(sql_str(b) for b in LABELED_BASES)
    _all_bases = ", ".join(sql_str(b) for b in [*LABELED_BASES, *ABSTAINED_BASES])
    macro_checks = check([
        (
            "one output row per input row",
            """SELECT abs(
                 (SELECT count(*) FROM categorize_by_exemption('lake.parcels_current'))
               - (SELECT count(*) FROM lake.parcels_current))""",
        ),
        (
            "basis is never NULL and always a known value",
            f"""SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
                WHERE basis IS NULL OR basis NOT IN ({_all_bases})""",
        ),
        (
            "owner_type is NULL or a known category",
            f"""SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
                WHERE owner_type IS NOT NULL AND owner_type NOT IN ({_cats})""",
        ),
        (
            "owner_type is non-NULL exactly when basis is a labeling basis",
            f"""SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
                WHERE (owner_type IS NOT NULL) != (basis IN ({_labeled}))""",
        ),
        (
            "nothing labeled `person` carries a TRUST token",
            """SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
               WHERE owner_type = 'person' AND contains(owner_name, 'TRUST')""",
        ),
        (
            "nothing labeled `person` carries a corporate token",
            f"""SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
                WHERE owner_type = 'person'
                  AND regexp_matches(owner_name, {sql_str(CORPORATE_NAME_PATTERN)})""",
        ),
        (
            "every labeled parcel carries an exemption",
            """SELECT count(*) FROM categorize_by_exemption('lake.parcels_current')
               WHERE owner_type IS NOT NULL
                 AND exemption_1_type IS NULL AND exemption_2_type IS NULL
                 AND exemption_5_type IS NULL AND exemption_6_type IS NULL""",
        ),
    ])
    macro_checks
    return


@app.cell
def _():
    mo.md(r"""
    ### A golden fixture

    Seven hand-written rows, one per branch of the rule. This pins the ` - LAND`
    stripping, the `NAVITE` alias, the slot-2-only case, both name guards, the
    use-based refusal, and the no-exemption default — without needing the lake.
    """)
    return


@app.cell
def _(con, macro):
    con.execute("""
        CREATE OR REPLACE TABLE fixture AS
        SELECT * FROM (VALUES
          ('land-suffix stripped',      'ANCHORAGE MUNICIPALITY OF', 'MOA OWNED (EXC. SCHOOLS) - LAND', NULL, NULL, NULL),
          ('slot 2 only, NAVITE alias', 'EKLUTNA INC',               NULL, 'NAVITE GROUPS / CORP OWNED', NULL, NULL),
          ('residential exemption',     'SMITH JOHN A',              NULL, NULL, NULL, 'OWNERS PRIMARY RESIDENCE'),
          ('trust guard',               'SMITH FAMILY TRUST',        NULL, NULL, 'SENIOR SELF: PRIMARY RESI', NULL),
          ('corporate guard',           'ACME RENTALS LLC',          NULL, NULL, NULL, 'OWNERS PRIMARY RESIDENCE'),
          ('use-based, no owner claim', 'HULTQUIST HOMES INC',       'SUBDIVISION', NULL, NULL, NULL),
          ('no exemption',              'DOE JANE',                  NULL, NULL, NULL, NULL)
        ) t(scenario, owner_name, exemption_1_type, exemption_2_type, exemption_5_type, exemption_6_type)
    """)

    fixture_result = con.execute("""
        SELECT scenario, owner_name, owner_type, basis
        FROM categorize_by_exemption('fixture') ORDER BY scenario
    """).pl()

    expected = pl.DataFrame(
        [
            ("corporate guard", None, "person_exemption_corporate_named"),
            ("land-suffix stripped", "government", "owner_identifying_exemption"),
            ("no exemption", None, "no_exemption"),
            ("residential exemption", "person", "person_exemption"),
            ("slot 2 only, NAVITE alias", "native_corp", "owner_identifying_exemption"),
            ("trust guard", None, "person_exemption_trust_named"),
            ("use-based, no owner claim", None, "use_based_exemption_only"),
        ],
        schema=["scenario", "owner_type", "basis"],
        orient="row",
    )
    assert fixture_result.drop("owner_name").equals(expected), fixture_result
    fixture_result
    return


@app.cell
def _():
    mo.md(r"""
    ## Coverage

    What the rule actually buys, on all 98,519 parcels.
    """)
    return


@app.cell
def _(macro, q):
    coverage = q("""
        SELECT
          basis,
          coalesce(owner_type, '— abstained —') AS owner_type,
          count(*) AS n,
          round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct
        FROM categorize_by_exemption('lake.parcels_current')
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
def _(macro, q):
    totals = q("""
        SELECT
          count(*) FILTER (owner_type IS NOT NULL) AS labeled,
          count(*) FILTER (owner_type IS NULL)     AS abstained,
          count(*)                                 AS total,
          round(100.0 * count(*) FILTER (owner_type IS NOT NULL) / count(*), 1) AS pct_labeled
        FROM categorize_by_exemption('lake.parcels_current')
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
        SELECT DISTINCT replace(
                 regexp_replace(coalesce(exemption_1_type, exemption_2_type), ' - LAND$', ''),
                 'NAVITE', 'NATIVE') AS base
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
    spot_check = q(f"""
        SELECT owner_name, count(*) AS parcels
        FROM lake.parcels_current
        WHERE replace(
                regexp_replace(coalesce(exemption_1_type, exemption_2_type), ' - LAND$', ''),
                'NAVITE', 'NATIVE') = {sql_str(base_picker.value)}
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
    [owner_type_from_names.py](owner_type_from_names.py) imports this macro,
    takes the abstentions, and starts there.
    """)
    return


if __name__ == "__main__":
    app.run()
