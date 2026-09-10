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
"""Check the two answer keys in research/owners/.

We use owner_type.csv and voter_match.csv to measure how well a
program can name the kind of owner of a parcel, and find the owner in the voter
file. This notebook builds the two pools of parcels again, takes the two
samples again, and then makes sure that the parcel IDs it gets are still
exactly the parcel IDs in the CSV files. If the lake changes in a way that
changes which parcels we sampled, the notebook stops with an error. It does not
change quietly.

The notebook also makes sure that each label is one of the values we allow,
that no row is missing or double, and that every matched voter number is a real
voter (but only if you have the voter file on your machine).

A model wrote the labels — see README.md. This notebook does not write
them again. It only looks at their shape, and at where they came from.

Run with:  uvx marimo edit --sandbox research/owners/check.py
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

    HERE = Path(__file__).resolve().parent
    REPO_ROOT = HERE.parents[1]
    SOURCES_DIR = REPO_ROOT / "sources"

    # These four values define the two samples. Do not change them: they are
    # what lets anyone get the same rows again.
    OWNER_TYPE_SALT = "gold-owner-type-v1"
    OWNER_TYPE_N = 300
    VOTER_SALT = "gold-voter-match-v1"
    VOTER_N = 150

    # The two levels of owner type, from issue #9. A kind for every owner, and
    # more detail for an org.
    KINDS = {"person", "org", "trust", "other"}
    ORG_CATEGORIES = {"government", "native_corp", "nonprofit", "hoa", "business"}
    VOTER_LABELS = {"match", "no_match", "ambiguous"}
    CONFIDENCE = {"high", "medium", "low"}

    # Cuts "C/O ...", "ATTN: ..." and extra spaces off an owner name. This is
    # the same cleaner that owner_type_from_names.py uses.
    CLEAN = (
        r"trim(regexp_replace(regexp_replace(owner_name,"
        r" '\s(%\s*[A-Z]|C/O\s|C\\O\s|ATTN:?\s).*$', ''), '\s{2,}', ' ', 'g'))"
    )

    # If an owner name holds one of these words, we do not treat it as a
    # person. The list is long on purpose — see README.md for what it misses.
    PERSON_LIKE_EXCLUDE = (
        "(LLC|L L C|INC|CORP|COMPANY|( |^)CO( |$)|( |^)LP( |$)|L P|LTD|LIMITED|"
        "PARTNERSHIP|ASSOC|ASSN|HOMEOWNER|CONDO|VILLAGE|ESTATES|PROPERT|HOLDING|"
        "INVESTMENT|REALTY|RENTAL|RANCH|FARM|BANK|CHURCH|MINISTR|MISSION|"
        "MUNICIPAL|BOROUGH|STATE OF|UNITED STATES|FEDERAL|NATIVE|TRIBAL|SCHOOL|"
        "UNIVERSITY|HOSPITAL|FOUNDATION|ALLIANCE|SERVICES|SYSTEMS|GROUP|"
        "ENTERPRISE|MANAGEMENT|DEVELOPMENT|CARGO|AIRLIN|UTILITY|ELECTRIC|"
        "CEMETERY|LODGE|( |^)CLUB( |$)|SOCIETY|COUNCIL|AUTHORITY|DBA)"
    )


@app.cell
def _():
    mo.md(r"""
    # Answer keys — check the samples and the labels

    Two sets of hand-labeled parcels. We took both samples only from the
    parcels that the exemption rules could **not** label, because those are the
    parcels a program is asked about. A score on the parcels that are easy to
    label tells you nothing about the hard ones.

    This notebook shows that anyone can get the same sample again, and that
    every label has the shape we expect. [README.md](README.md) tells the story
    and gives the warnings.
    """)
    return


@app.cell
def _():
    _local = (
        REPO_ROOT
        / "workspaces"
        / "default"
        / "anchorage.duckdb"
    )
    _lake = (
        str(_local)
        if _local.exists()
        else "https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/anchorage.duckdb"
    )
    con = duckdb.connect()
    con.execute(f"ATTACH '{_lake}' AS lake (READ_ONLY);")

    # The leftover parcels: the exemption rules gave them no owner type, and
    # their name holds no company word, no trust word, and is not the
    # placeholder text. A program has to guess for exactly these parcels.
    con.execute(f"""
        CREATE OR REPLACE VIEW residual AS
        WITH ambiguous AS (
          SELECT * FROM lake.exemptions.categorize_by_exemption('lake.parcels_current')
          WHERE owner_type IS NULL
        ), c AS (SELECT *, {CLEAN} AS owner_name_clean FROM ambiguous)
        SELECT * FROM c
        WHERE owner_name_clean <> 'PROPERTY OWNER OF RECORD'
          AND NOT regexp_matches(owner_name_clean, '(^| )(LLC|INC|CORP|LP|LTD)(\\.|,|$| )')
          AND NOT contains(owner_name_clean, 'TRUST')
          AND NOT regexp_matches(owner_name_clean, '(^| )(TR|TRS|TTE|TTES|TRUSTEE)(\\.|,|/|$| )')
    """)
    con.execute(f"""
        CREATE OR REPLACE VIEW person_like AS
        SELECT * FROM residual
        WHERE regexp_matches(owner_name_clean, '^[A-Z][A-Z''-]+\\s')
          AND NOT regexp_matches(owner_name_clean, '{PERSON_LIKE_EXCLUDE}')
    """)

    def q(sql: str) -> pl.DataFrame:
        return con.execute(sql).pl()

    pool_sizes = q("""
        SELECT 'residual (leftover parcels)' AS pool, count(*) AS parcels FROM residual
        UNION ALL SELECT 'person_like (owners that look like people)', count(*) FROM person_like
    """)
    pool_sizes
    return con, q


@app.cell
def _():
    mo.md(r"""
    ## Can we get the same sample again?

    Take each sample again with its salt, and compare the `parcel_id`s with the
    ones in the CSV files. They must be the same set. If the lake changes in a
    way that brings in different parcels, this cell stops with an error. That is
    better than an answer key that quietly describes parcels other than the ones
    its labels are about.
    """)
    return


@app.cell
def _(con, q):
    owner_key = pl.read_csv(
        HERE / "owner_type.csv",
        # parcel_id must stay text: it has leading zeros, and DuckDB hands it
        # back as text. Let polars infer it and it becomes an integer, the
        # zeros vanish, and every id comparison below fails.
        schema_overrides={
            "parcel_id": pl.String,
            "org_category": pl.String,
            "notes": pl.String,
        },
    )
    # voter_match.csv has one row for each person named on a parcel, not one
    # row for each parcel. "SMITH JOHN & JANE" is two rows. See issue #9.
    voter_key = pl.read_csv(
        HERE / "voter_match.csv",
        schema_overrides={
            "parcel_id": pl.String,
            "matched_ascension": pl.String,
            "share": pl.String,
            "notes": pl.String,
        },
    )

    sample_owner = q(f"""
        SELECT parcel_id FROM residual
        ORDER BY hash(parcel_id || '{OWNER_TYPE_SALT}') LIMIT {OWNER_TYPE_N}
    """)
    sample_voter = q(f"""
        SELECT parcel_id FROM person_like
        ORDER BY hash(parcel_id || '{VOTER_SALT}') LIMIT {VOTER_N}
    """)

    def id_set_matches(sampled: pl.DataFrame, key: pl.DataFrame) -> tuple[int, int]:
        # A parcel ID can appear more than once in the CSV, because a parcel can
        # name more than one person. So compare the sets, not the row counts.
        a, b = set(sampled["parcel_id"]), set(key["parcel_id"])
        return len(a - b), len(b - a)

    o_missing, o_extra = id_set_matches(sample_owner, owner_key)
    v_missing, v_extra = id_set_matches(sample_voter, voter_key)
    assert (o_missing, o_extra) == (0, 0), (
        f"the owner_type sample changed: {o_missing} parcel(s) are now in the "
        f"sample but not in the CSV, {o_extra} are in the CSV but not in the sample"
    )
    assert (v_missing, v_extra) == (0, 0), (
        f"the voter_match sample changed: {v_missing} parcel(s) are now in the "
        f"sample but not in the CSV, {v_extra} are in the CSV but not in the sample"
    )

    same_sample = pl.DataFrame(
        {
            "file": ["owner_type.csv", "voter_match.csv"],
            "parcels": [
                owner_key["parcel_id"].n_unique(),
                voter_key["parcel_id"].n_unique(),
            ],
            "rows": [len(owner_key), len(voter_key)],
            "same_parcels_as_csv": [True, True],
        }
    )
    same_sample
    return owner_key, voter_key


@app.cell
def _():
    mo.md(
        r"""## Are the labels well formed?

        Each label must be a value we allow. Each parcel and each person must
        appear the correct number of times. A row must have a voter number if,
        and only if, it is a match.
        """
    )
    return


@app.cell
def _(owner_key, voter_key):
    checks: list[dict] = []

    def check(name: str, ok: bool) -> None:
        checks.append({"check": name, "passed": bool(ok)})

    def org_cat(df: pl.DataFrame) -> pl.Series:
        return df["org_category"].fill_null("").str.strip_chars()

    # owner_type.csv — one row for each parcel, with kind and org_category
    check("owner_type: has 300 rows", len(owner_key) == OWNER_TYPE_N)
    check(
        "owner_type: each parcel appears once only",
        owner_key["parcel_id"].n_unique() == len(owner_key),
    )
    check(
        "owner_type: every kind is a value we allow", set(owner_key["kind"]) <= KINDS
    )
    check(
        "owner_type: every org_category is a value we allow",
        set(org_cat(owner_key)) <= (ORG_CATEGORIES | {""}),
    )
    check(
        "owner_type: every confidence is a value we allow",
        set(owner_key["confidence"]) <= CONFIDENCE,
    )
    # An owner has an org_category if, and only if, its kind is "org".
    check(
        "owner_type: an owner has an org_category only if its kind is org",
        bool(((owner_key["kind"] == "org") == (org_cat(owner_key) != "")).all()),
    )

    # voter_match.csv — one row for each person named on a parcel
    check(
        "voter_match: each person on a parcel appears once only",
        voter_key.select("parcel_id", "person_idx").n_unique() == len(voter_key),
    )
    check(
        "voter_match: all 150 sampled parcels are here",
        voter_key["parcel_id"].n_unique() == VOTER_N,
    )
    check(
        "voter_match: every kind is a value we allow", set(voter_key["kind"]) <= KINDS
    )
    check(
        "voter_match: every label is a value we allow",
        set(voter_key["label"]) <= VOTER_LABELS,
    )
    check(
        "voter_match: every confidence is a value we allow",
        set(voter_key["confidence"]) <= CONFIDENCE,
    )
    # A row has a voter number if, and only if, we labeled it a match.
    _is_match = voter_key["label"] == "match"
    _has_asc = voter_key["matched_ascension"].fill_null("").str.strip_chars() != ""
    check(
        "voter_match: a row has a voter number only if it is a match",
        bool((_is_match == _has_asc).all()),
    )
    # If the source gives a share for every person on a parcel, the shares must
    # add up to 1.
    _shares = voter_key.with_columns(
        s=pl.col("share")
        .fill_null("")
        .str.strip_chars()
        .replace("", None)
        .cast(pl.Float64, strict=False)
    )
    _fully = (
        _shares.group_by("parcel_id")
        .agg(n=pl.len(), ns=pl.col("s").is_not_null().sum(), tot=pl.col("s").sum())
        .filter((pl.col("n") == pl.col("ns")) & (pl.col("ns") > 0))
    )
    check(
        "voter_match: the shares on a parcel add up to 1",
        bool(((_fully["tot"] - 1.0).abs() < 1e-3).all()),
    )

    results = pl.DataFrame(checks)
    _failed = results.filter(~pl.col("passed"))
    assert len(_failed) == 0, f"{len(_failed)} check(s) did not pass:\n{_failed}"
    results
    return


@app.cell
def _():
    mo.md(r"""
    ## Is each matched voter number real?

    This cell runs only if you have `sources/voterfile.csv` on your machine. The
    file is not in git — you must get it yourself. The cell makes sure that
    every `matched_ascension` number is in the file.
    """)
    return


@app.cell
def _(con, voter_key):
    _vf = SOURCES_DIR / "voterfile.csv"
    if _vf.exists():
        con.execute(f"""
            CREATE OR REPLACE VIEW voters AS
            SELECT ASCENSION FROM read_csv('{_vf}', header=true, all_varchar=true)
        """)
        _ids = [
            a for a in voter_key["matched_ascension"].to_list() if a and str(a).strip()
        ]
        _found = con.execute(
            "SELECT count(DISTINCT ASCENSION) FROM voters WHERE ASCENSION IN "
            f"({','.join(repr(str(i)) for i in _ids)})"
        ).fetchone()[0]
        assert _found == len(set(_ids)), (
            f"{len(set(_ids)) - _found} matched_ascension number(s) are not in the "
            "voter file"
        )
        ascension_check = pl.DataFrame(
            {"matched_numbers": [len(set(_ids))], "found_in_voter_file": [_found]}
        )
    else:
        ascension_check = mo.md(
            "`sources/voterfile.csv` is not here — this check did not run."
        )
    ascension_check
    return


@app.cell
def _():
    mo.md(r"""## Distributions""")
    return


@app.cell
def _(owner_key):
    owner_dist = (
        owner_key.with_columns(
            type=pl.when(pl.col("kind") == "org")
            .then(pl.col("kind") + " / " + pl.col("org_category"))
            .otherwise(pl.col("kind"))
        )
        .group_by("type", "confidence")
        .len("n")
        .sort("n", descending=True)
    )
    _plot = (
        alt.Chart(owner_dist)
        .mark_bar()
        .encode(
            x=alt.X("n:Q", title="parcels"),
            y=alt.Y("type:N", sort="-x", title=None),
            color=alt.Color(
                "confidence:N",
                scale=alt.Scale(
                    domain=["high", "medium", "low"],
                    range=["#4c78a8", "#f0a03f", "#d95f5f"],
                ),
            ),
            tooltip=["type", "confidence", "n"],
        )
        .properties(height=200, title="owner_type.csv (kind / org_category)")
    )
    mo.ui.altair_chart(_plot)
    return


@app.cell
def _(voter_key):
    voter_dist = (
        voter_key.group_by("label", "confidence").len("n").sort("n", descending=True)
    )
    _plot = (
        alt.Chart(voter_dist)
        .mark_bar()
        .encode(
            x=alt.X("n:Q", title="owners"),
            y=alt.Y("label:N", sort="-x", title=None),
            color=alt.Color(
                "confidence:N",
                scale=alt.Scale(
                    domain=["high", "medium", "low"],
                    range=["#4c78a8", "#f0a03f", "#d95f5f"],
                ),
            ),
            tooltip=["label", "confidence", "n"],
        )
        .properties(height=140, title="voter_match.csv")
    )
    mo.ui.altair_chart(_plot)
    return


if __name__ == "__main__":
    app.run()
