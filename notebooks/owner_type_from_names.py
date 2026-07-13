# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo>=0.23.3",
#     "duckdb>=1.5.2",
#     "altair>=5.4",
#     "polars>=1.10",
#     "pyarrow>=17",
# ]
# ///
"""Categorize the parcels the exemptions cannot: what `owner_name` alone can tell us.

owner_type_from_exemptions.py labels 52% of parcels from the muni's exemption
slots and abstains on the other 47,309. For those, the only evidence left is
`owner_name` — a field assembled from three 30-character lines that overloads
`%` for two unrelated purposes and appends mail-routing junk to the owner.

This notebook profiles that population, proves out a cleaning step with
executable checks, and stops there. It is the place to hang a model: everything
below `## Where a model goes` is scaffolding waiting for one.

Run with:  uvx marimo edit --sandbox notebooks/owner_type_from_names.py
"""

import marimo

__generated_with = "0.23.9"
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

    # `owner_name` is three 30-char lines joined by single spaces, so a missing
    # middle line shows up as a double space rather than as a delimiter.
    OWNER_LINE_LENGTH = 30

    # A mail-routing fragment: everything from here to the end of the string
    # names an agent, manager, or bank — not the owner.
    #
    # The `%` branch demands whitespace *before* the sign and a letter after it.
    # That is what separates "PARTNERSHIP % ESKE LLC" (care-of) from
    # "LEE JIM 50% & VANG NEDA 50%" (fractional share), which is the same
    # character doing an unrelated job. `50 % &` — space before, `&` after —
    # stays a share.
    AGENT_FRAGMENT_PATTERN = r"\s(%\s*[A-Z]|C/O\s|C\\O\s|ATTN:?\s).*$"

    # Not an owner. The muni's stand-in when it has no name on file.
    OWNER_NAME_PLACEHOLDER = "PROPERTY OWNER OF RECORD"


@app.cell
def _():
    mo.md(r"""
    # Owner type from names

    Exemptions settle 52% of parcels and say nothing at all about the rest. No
    exemption is granted for being a for-profit company, so every rental LLC,
    absentee owner, and commercial holding in Anchorage sits in the abstained
    pile, invisible to the rule in
    [owner_type_from_exemptions.py](owner_type_from_exemptions.py).

    All that is left for those 47,309 parcels is `owner_name`. Before any model
    reads it, it is worth knowing exactly what the field is — because it is not
    a name. It is three fixed-width lines of a mailing label, concatenated.
    """)
    return


@app.cell
def _():
    # Prefer the workspace's working copy (fresher, and guaranteed to carry the
    # exemptions schema after a local ingest); fall back to the published lake.
    _local = Path(__file__).resolve().parent.parent / "workspaces" / "default" / "anchorage.duckdb"
    _lake_source = (
        str(_local)
        if _local.exists()
        else "https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage.duckdb"
    )
    con = duckdb.connect()
    con.execute(f"ATTACH '{_lake_source}' AS lake (READ_ONLY);")

    # The exemption rule ships inside the lake (src/exemptions.ts, presented in
    # owner_type_from_exemptions.py); its abstentions are this notebook's input.
    con.execute("""
        CREATE OR REPLACE VIEW ambiguous AS
        SELECT * FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
        WHERE owner_type IS NULL
    """)


    def q(sql: str) -> pl.DataFrame:
        return con.execute(sql).pl()

    return con, q


@app.cell
def _():
    mo.md(r"""
    ## Who is left

    Four reasons a parcel lands here, and they are not equally hard. The 433
    use-based and 85 corporate-named parcels are rounding error. The 4,698
    trust-named ones need a taxonomy decision more than a model. The 42,093 with
    no exemption at all are the actual problem.
    """)
    return


@app.cell(hide_code=True)
def _(con):
    _df = mo.sql(
        f"""
        FROM
            ambiguous
        """,
        engine=con
    )
    return


@app.cell
def _(q):
    who_is_left = q("""
        SELECT basis, count(*) AS n,
               round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_ambiguous
        FROM ambiguous GROUP BY 1 ORDER BY n DESC
    """)
    who_is_left
    return


@app.cell
def _(q):
    surface_signal = q(r"""
        SELECT
          count(*) AS ambiguous_parcels,
          count(*) FILTER (contains(owner_name, 'TRUST'))                             AS trust_named,
          count(*) FILTER (regexp_matches(owner_name, '(^| )(LLC|INC|CORP|LP|LTD)(\.|,|$| )'))
                                                                                      AS corporate_named,
          count(*) FILTER (length(owner_line_1) = 30)                                 AS line_1_at_char_cap,
          count(*) FILTER (owner_name = 'PROPERTY OWNER OF RECORD')                   AS placeholder
        FROM ambiguous
    """)
    surface_signal
    return


@app.cell
def _():
    mo.md(r"""
    A naive token rule gets 7,630 corporate names and 8,167 trust names for free.
    That is a third of the pile — and precisely the third a model does not need
    to be asked about. The interesting residual is everything else.

    ## Trap 1 — `owner_name` is three mailing-label lines

    `owner_line_1` through `owner_line_3` are the name; `owner_line_4` is the
    street address and is not part of it. Each line is capped at 30 characters,
    and a name too long for one line simply continues on the next:

    ```
    owner_line_1  MASON JAMES E IRREVOCABLE
    owner_line_2  CREDIT SHELTER TRUST & MASON
    owner_line_3  JUNG JA REVOCABLE TRUST 50% EA
    owner_line_4  6225 STAEDEM DR
    ```

    `owner_name` is exactly `l1 + ' ' + l2 + ' ' + l3`, trimmed — with a NULL
    line contributing an empty string, not nothing. That is where the double
    spaces come from: they mark a *skipped* line 2, not a delimiter. Do not read
    them as one.
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
def _(check):
    structure_checks = check(
        [
            (
                "owner_name is exactly lines 1-3 joined by single spaces, then trimmed",
                """SELECT count(*) FROM lake.parcels_current
               WHERE owner_name IS DISTINCT FROM trim(
                 owner_line_1 || ' ' || coalesce(owner_line_2, '')
                              || ' ' || coalesce(owner_line_3, ''))""",
            ),
            (
                "no owner line exceeds 30 characters",
                f"""SELECT count(*) FROM lake.parcels_current WHERE
                 length(owner_line_1) > {OWNER_LINE_LENGTH}
              OR length(owner_line_2) > {OWNER_LINE_LENGTH}
              OR length(owner_line_3) > {OWNER_LINE_LENGTH}
              OR length(owner_line_4) > {OWNER_LINE_LENGTH}""",
            ),
            (
                "line 4 (the mailing address) is always present",
                "SELECT count(*) FROM lake.parcels_current WHERE owner_line_4 IS NULL",
            ),
            (
                "a double space in owner_name comes from a skipped line 2, or from a line that already had one",
                """SELECT count(*) FROM lake.parcels_current
               WHERE owner_name LIKE '%  %'
                 AND coalesce(owner_line_2, '') != ''
                 AND NOT (owner_line_1 LIKE '%  %'
                       OR coalesce(owner_line_2, '') LIKE '%  %'
                       OR coalesce(owner_line_3, '') LIKE '%  %')""",
            ),
        ]
    )
    structure_checks
    return


@app.cell
def _():
    mo.md(r"""
    ## Trap 2 — the 30-character cap eats the entity suffix

    Truncation lands exactly where the type signal lives. `ABBOTT LOOP COMMUNITY
    CHAPEL I`, `ALASKA HOUSING FINACE CORPORAT`, `GREATER FRIENDSHIP BAPTIST
    CHU` — the trailing `INC` / `CORP` / `CHURCH` token that a rule (or a model)
    keys on is the first casualty.

    5,938 parcels have `owner_line_1` at the cap. For 2,251 of them the name
    continues on line 2 or 3, so nothing is lost. For the other **3,687 it is
    simply cut off** and no amount of prompting recovers it. Any classifier must
    handle names that stop mid-word.
    """)
    return


@app.cell
def _(q):
    truncation = q(f"""
        SELECT
          count(*) FILTER (length(owner_line_1) = {OWNER_LINE_LENGTH}) AS line_1_at_cap,
          count(*) FILTER (length(owner_line_2) = {OWNER_LINE_LENGTH}) AS line_2_at_cap,
          count(*) FILTER (length(owner_line_3) = {OWNER_LINE_LENGTH}) AS line_3_at_cap,
          count(*) FILTER (length(owner_line_1) = {OWNER_LINE_LENGTH}
                       AND owner_line_2 IS NULL AND owner_line_3 IS NULL)
                                                                       AS truncated_unrecoverably
        FROM lake.parcels_current
    """)
    truncation
    return


@app.cell
def _(q):
    truncated_examples = q(f"""
        SELECT owner_name FROM ambiguous
        WHERE length(owner_line_1) = {OWNER_LINE_LENGTH}
          AND owner_line_2 IS NULL AND owner_line_3 IS NULL
        ORDER BY owner_name LIMIT 12
    """)
    truncated_examples
    return


@app.cell
def _(check):
    truncation_checks = check(
        [
            (
                "the cap is real: some line-1 values sit exactly at 30 chars",
                f"""SELECT CASE WHEN count(*) FILTER (length(owner_line_1) = {OWNER_LINE_LENGTH}) > 0
                           THEN 0 ELSE 1 END FROM lake.parcels_current""",
            ),
            (
                "at-cap line 1 with no continuation is unrecoverable, and there are thousands",
                f"""SELECT CASE WHEN count(*) FILTER (
                             length(owner_line_1) = {OWNER_LINE_LENGTH}
                             AND owner_line_2 IS NULL AND owner_line_3 IS NULL) > 1000
                           THEN 0 ELSE 1 END FROM lake.parcels_current""",
            ),
        ]
    )
    truncation_checks
    return


@app.cell
def _():
    mo.md(r"""
    ## Trap 3 — `%` means two different things

    6,042 names contain a `%`. It is doing two unrelated jobs:

    - **Fractional ownership**, 4,810 names: `LEE JIM 50% & VANG NEDA 50%`,
      `BERVELL T A 25% & BERVELL R B 25% & ...`. This is part of the name and
      carries real signal — a 50/50 split is a strong `person` tell.
    - **Care-of**, 1,278 names: `BAILEY FAMILY LTD PARTNERSHIP % ESKE LLC`,
      `PIONEERS OF ALASKA IGLOO 15 % MOA/CEMETERY`. Here `%` is the muni's
      abbreviation for "c/o", and everything after it is a *managing agent*, not
      the owner. A rule looking for `MOA` would call that second one government.

    The two are separated by one character of context: a share has no whitespace
    before the sign; a care-of does, and is followed by a letter. `50 % &` is a
    share; `15 % MOA` is a care-of.

    And there is a third, separate hazard: **`%` is the SQL `LIKE` wildcard.**
    `owner_name LIKE '%'` matches all 98,519 rows. Use `contains()`, or `LIKE
    '%\%%' ESCAPE '\'`. Filtering on `%` without escaping it silently returns the
    whole table.
    """)
    return


@app.cell
def _(q):
    percent_usage = q(r"""
        SELECT
          count(*) FILTER (contains(owner_name, '%'))                     AS names_with_percent,
          count(*) FILTER (regexp_matches(owner_name, '[0-9]\s*%'))       AS fractional_share,
          count(*) FILTER (regexp_matches(owner_name, '\s%\s*[A-Z]'))     AS care_of_percent,
          count(*) FILTER (regexp_matches(owner_name, '\sC/O\s|\sC\\O\s')) AS care_of_spelled_out,
          count(*) FILTER (regexp_matches(owner_name, '\sATTN:?\s'))      AS attn,
          count(*) FILTER (owner_name LIKE '%')                           AS unescaped_like_matches
        FROM lake.parcels_current
    """)
    percent_usage
    return


@app.cell
def _(check):
    percent_checks = check(
        [
            (
                "an unescaped LIKE '%' matches every row — the wildcard trap is live",
                """SELECT count(*) - count(*) FILTER (owner_name LIKE '%')
               FROM lake.parcels_current""",
            ),
            (
                "escaping it finds the names that really contain a percent sign",
                r"""SELECT abs(
                  count(*) FILTER (owner_name LIKE '%\%%' ESCAPE '\')
                - count(*) FILTER (contains(owner_name, '%')))
                FROM lake.parcels_current""",
            ),
            (
                "contains() is unaffected by the wildcard, and finds strictly fewer rows than a bare LIKE",
                """SELECT CASE WHEN count(*) FILTER (contains(owner_name, '%')) < count(*)
                          THEN 0 ELSE 1 END FROM lake.parcels_current""",
            ),
        ]
    )
    percent_checks
    return


@app.cell
def _():
    mo.md(r"""
    ## The cleaning step

    Strip the mail-routing fragment, collapse the double spaces left by a skipped
    line 2, and leave the fractional shares alone. Nothing else: no
    lowercasing, no suffix normalization, no guessing. The cleaner's one job is
    to stop feeding a downstream model text that belongs to somebody else.
    """)
    return


@app.function
def clean_owner_name_sql(column: str = "owner_name") -> str:
    """SQL expression that strips agent fragments and collapses runs of spaces."""
    return (
        f"trim(regexp_replace("
        f"regexp_replace({column}, {sql_str(AGENT_FRAGMENT_PATTERN)}, ''),"
        r" '\s{2,}', ' ', 'g'))"
    )


@app.cell
def _():
    mo.md(f"""
    ```sql\n{clean_owner_name_sql()}\n```
    """)
    return


@app.cell
def _(q):
    _clean = clean_owner_name_sql()
    cleaning_effect = q(f"""
        SELECT owner_name, {_clean} AS cleaned
        FROM lake.parcels_current
        WHERE owner_name != {_clean}
        ORDER BY owner_name LIMIT 20
    """)
    cleaning_effect
    return


@app.cell
def _():
    mo.md(r"""
    ### Checks on the cleaner

    The cleaner must be **complete where it acts and lossless where it doesn't**:
    it may never empty a name, must leave behind no fragment it claims to remove,
    and must be idempotent.

    It is not perfectly lossless, and the exceptions are pinned by count rather
    than papered over. Three names lose a fractional share because they are
    irreducibly ambiguous — `GARDNER DANIEL J 50 % WILLITS JAMES A 50%` uses
    `space % space letter` as a share separator, which is character-for-character
    the care-of pattern. Nine names keep a `%` the cleaner cannot parse: `%50`
    prefixes, `% 611 LLC`, `HAGER% DENNIS%`. Both counts are asserted, so if
    upstream data drifts, this notebook says so.
    """)
    return


@app.cell
def _(check):
    _clean = clean_owner_name_sql()
    _agent = sql_str(AGENT_FRAGMENT_PATTERN)
    cleaner_checks = check(
        [
            (
                "the cleaner never empties a name",
                f"SELECT count(*) FROM lake.parcels_current WHERE {_clean} = ''",
            ),
            (
                "no agent fragment survives cleaning",
                f"""SELECT count(*) FROM lake.parcels_current
                WHERE regexp_matches({_clean}, {_agent})""",
            ),
            (
                "cleaning is idempotent",
                f"""SELECT count(*) FROM lake.parcels_current
                WHERE {clean_owner_name_sql(_clean)} != {_clean}""",
            ),
            (
                "no double spaces survive cleaning",
                f"SELECT count(*) FROM lake.parcels_current WHERE {_clean} LIKE '%  %'",
            ),
            (
                "exactly 3 names lose a fractional share (irreducibly ambiguous, listed below)",
                rf"""SELECT abs(3 - count(*)) FROM lake.parcels_current
                 WHERE regexp_matches(owner_name, '[0-9]%')
                   AND NOT regexp_matches({_clean}, '[0-9]%')""",
            ),
            (
                "exactly 9 names still hold an unparseable % after cleaning",
                rf"""SELECT abs(9 - count(*)) FROM lake.parcels_current
                 WHERE contains({_clean}, '%')
                   AND NOT regexp_matches({_clean}, '[0-9]\s*%')""",
            ),
        ]
    )
    cleaner_checks
    return


@app.cell
def _(q):
    _clean = clean_owner_name_sql()
    percent_casualties = q(rf"""
        SELECT DISTINCT 'share destroyed' AS problem, owner_name, {_clean} AS cleaned
        FROM lake.parcels_current
        WHERE regexp_matches(owner_name, '[0-9]%') AND NOT regexp_matches({_clean}, '[0-9]%')
        UNION ALL
        SELECT DISTINCT '% left unparsed', owner_name, {_clean}
        FROM lake.parcels_current
        WHERE contains({_clean}, '%') AND NOT regexp_matches({_clean}, '[0-9]\s*%')
        ORDER BY problem, owner_name
    """)
    percent_casualties
    return


@app.cell
def _():
    mo.md(r"""
    ### A golden fixture

    One row per behavior. `HANDELAND DONALD 50 % &` and `IGLOO 15 % MOA` are the
    pair that any simpler rule gets wrong: identical `digit space % space` shape,
    opposite meanings.
    """)
    return


@app.cell
def _(con):
    con.execute("""
        CREATE OR REPLACE TABLE name_fixture AS
        SELECT * FROM (VALUES
          ('care-of percent',        'BAILEY FAMILY LTD PARTNERSHIP % ESKE LLC',   'BAILEY FAMILY LTD PARTNERSHIP'),
          ('care-of, no space',      'TRANSPACIFIC RESOURCES %GTK COMMERCIAL',     'TRANSPACIFIC RESOURCES'),
          ('care-of after a number', 'PIONEERS OF ALASKA IGLOO 15 % MOA/CEMETERY', 'PIONEERS OF ALASKA IGLOO 15'),
          ('share with loose space', 'HANDELAND DONALD 50 % & BANNAN BREANNA 50%', 'HANDELAND DONALD 50 % & BANNAN BREANNA 50%'),
          ('share, tight',           'LEE JIM 50% & VANG NEDA 50%',                'LEE JIM 50% & VANG NEDA 50%'),
          ('share, EA suffix',       'MASON JUNG JA REVOCABLE TRUST 50% EA',       'MASON JUNG JA REVOCABLE TRUST 50% EA'),
          ('c/o spelled out',        'YOUNGER SVETLANA & ROBERT O III C/O PARAGON PROPERTIES INC', 'YOUNGER SVETLANA & ROBERT O III'),
          ('backslash c\\o',         'TKB LLC C\\O CANGE & CHAMBERS',              'TKB LLC'),
          ('attn with colon',        'MCKINLEY PROPERTIES INC  ATTN: 05-5080',     'MCKINLEY PROPERTIES INC'),
          ('attn without colon',     'FLT AURORA PARK LLC 43% ATTN LEAGLE DEPT',   'FLT AURORA PARK LLC 43%'),
          ('skipped line 2',         'HEITMAN FAMILY TRUST  HEITMAN MICHAEL',      'HEITMAN FAMILY TRUST HEITMAN MICHAEL'),
          ('untouched',              'SOISETH LYNN A & ANITA K',                   'SOISETH LYNN A & ANITA K')
        ) t(scenario, owner_name, expected)
    """)

    name_fixture = con.execute(f"""
        SELECT scenario, owner_name, {clean_owner_name_sql()} AS cleaned, expected
        FROM name_fixture ORDER BY scenario
    """).pl()

    _wrong = name_fixture.filter(pl.col("cleaned") != pl.col("expected"))
    assert len(_wrong) == 0, f"cleaner mismatches:\n{_wrong}"
    name_fixture
    return


@app.cell
def _():
    mo.md(r"""
    ## Trap 4 — names that are not names

    480 parcels (135 of them ambiguous) carry the literal placeholder
    `PROPERTY OWNER OF RECORD`. 14 names use a backslash where a hyphen or slash
    belongs: `CO\TTES` is *co-trustees*, `C\O` is *care-of*. And 69 ambiguous
    names abbreviate trust to `TR`, `TTE`, `TTES`, or `/TRUSTEE`, which a
    `contains('TRUST')` guard misses entirely. The counts below are for the
    ambiguous population only.

    None of these are worth a model. They are worth a lookup table.
    """)
    return


@app.cell
def _(q):
    not_names = q(r"""
        SELECT 'placeholder, no owner on file' AS trap,
               count(*) FILTER (owner_name = 'PROPERTY OWNER OF RECORD') AS ambiguous_parcels,
               'PROPERTY OWNER OF RECORD' AS example
        FROM ambiguous
        UNION ALL SELECT 'backslash for hyphen or slash',
               count(*) FILTER (contains(owner_name, chr(92))),
               'DIRKS JEFF & ANGELA LIVING TRUST DIRKS J R & M A CO\TTES'
        FROM ambiguous
        UNION ALL SELECT 'trust abbreviated, TRUST token absent',
               count(*) FILTER (
                 regexp_matches(owner_name, '(^| )(TR|TRS|TTE|TTES|TRUSTEE|TRUSTEES)(\.|,|/|$| )')
                 AND NOT contains(owner_name, 'TRUST')),
               'GRAHAME HEATHER H REV TRUST 5 FORD D KENNETH REV TRUST 50% GRAHAME H H & FORD D K/TRUSTEE'
        FROM ambiguous
        ORDER BY ambiguous_parcels DESC
    """)
    not_names
    return


@app.cell
def _():
    mo.md(r"""
    ## What a model actually has to do

    Strip the traps away and the residual is smaller than 47,309. Token rules
    handle the corporate and trust names; the placeholder and the truncated
    stubs are not classifiable by anyone. What remains is the genuinely
    ambiguous set.
    """)
    return


@app.cell
def _(q):
    _clean = clean_owner_name_sql()
    residual = q(rf"""
        WITH c AS (SELECT {_clean} AS name FROM ambiguous)
        SELECT
          CASE
            WHEN name = '{OWNER_NAME_PLACEHOLDER}'                              THEN 'placeholder — unclassifiable'
            WHEN regexp_matches(name, '(^| )(LLC|INC|CORP|LP|LTD)(\.|,|$| )')   THEN 'corporate token — rule suffices'
            WHEN contains(name, 'TRUST')                                        THEN 'trust token — rule suffices'
            WHEN regexp_matches(name, '(^| )(TR|TRS|TTE|TTES|TRUSTEE)(\.|,|/|$| )')
                                                                                THEN 'trust abbreviation — rule suffices'
            ELSE                                                                     'residual — needs a model'
          END AS disposition,
          count(*) AS n,
          round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
        FROM c GROUP BY 1 ORDER BY n DESC
    """)
    residual
    return (residual,)


@app.cell
def _(residual):
    _plot = (
        alt.Chart(residual)
        .mark_bar()
        .encode(
            x=alt.X("n:Q", title="ambiguous parcels"),
            y=alt.Y("disposition:N", sort="-x", title=None),
            color=alt.Color(
                "disposition:N",
                legend=None,
                scale=alt.Scale(
                    domain=residual["disposition"].to_list(),
                    range=[
                        "#4c78a8" if d.startswith("residual") else "#b0b8c4"
                        for d in residual["disposition"]
                    ],
                ),
            ),
            tooltip=["disposition", "n", "pct"],
        )
        .properties(height=180)
    )
    mo.ui.altair_chart(_plot)
    return


@app.cell
def _(q):
    _clean = clean_owner_name_sql()
    residual_sample = q(rf"""
        SELECT {_clean} AS name, basis
        FROM ambiguous
        WHERE {_clean} != '{OWNER_NAME_PLACEHOLDER}'
          AND NOT regexp_matches({_clean}, '(^| )(LLC|INC|CORP|LP|LTD)(\.|,|$| )')
          AND NOT contains({_clean}, 'TRUST')
          AND NOT regexp_matches({_clean}, '(^| )(TR|TRS|TTE|TTES|TRUSTEE)(\.|,|/|$| )')
        USING SAMPLE 25 ROWS
    """)
    residual_sample
    return


@app.cell
def _():
    mo.md(r"""
    ## Where a model goes

    The residual is mostly bare personal names, and the hard cases are the
    handful that are not: `MCMILLEN & ASSOC`, `907 LAND HOLDINGS VIII`,
    `ABBOTT LOOP COMMUNITY CHAPEL I`. A model reads the cleaned name and returns
    one of `government`, `native_corp`, `nonprofit`, `hoa`, `business`,
    `person`, `other`, or `unsure`.

    Two constraints inherited from the notebook upstream:

    - **`business` has no ground truth anywhere in this dataset.** It cannot be
      validated against the muni's own labels, only spot-checked. Every other
      category can be scored against the exemption rule's output.
    - **The scoring set is not the target set.** An owner-occupier with a senior
      exemption is not a random parcel. Accuracy measured on the 51,210 labeled
      parcels does not transfer to the 47,309 unlabeled ones, and reporting it as
      if it does would be the single easiest way to be confidently wrong here.

    A defensible evaluation therefore needs hand-labels drawn from the residual
    itself. A few hundred would do. That is the next piece of work, and it comes
    before choosing a model, not after.
    """)
    return


if __name__ == "__main__":
    app.run()
