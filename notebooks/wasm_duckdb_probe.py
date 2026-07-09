# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "duckdb>=1.5.2",
# ]
# ///
"""Can a WASM-exported marimo notebook read a .duckdb file from a public URL?

Background: exporting these notebooks with `marimo export html-wasm` swaps native
duckdb for the Pyodide build, which cannot load extensions. That kills the
`ATTACH 'ducklake:https://...'` we use elsewhere, since ducklake is an extension.

This notebook probes whether attaching a plain .duckdb file would fare better.
It runs the same probes natively and under WASM so the two can be compared:

    uv run marimo edit notebooks/wasm_duckdb_probe.py     # native baseline
    uv run marimo export html-wasm notebooks/wasm_duckdb_probe.py --output /tmp/wasm_duckdb_probe --mode run --no-sandbox -f && python3 -m http.server --directory /tmp/wasm_duckdb_probe

Each probe records whether it succeeded and why it failed, rather than raising,
so one failure does not hide the results of the others.
"""

import marimo

__generated_with = "0.23.13"
app = marimo.App(width="medium")


@app.cell
def _():
    import sys
    import time
    import traceback

    import duckdb
    import marimo as mo

    IS_WASM = sys.platform == "emscripten"
    return IS_WASM, duckdb, mo, sys, time, traceback


@app.cell
def _(IS_WASM, duckdb, mo, sys):
    mo.md(
        f"""
        # DuckDB-over-HTTP probe

        | | |
        |---|---|
        | Platform | `{sys.platform}` |
        | Running under WASM | **{IS_WASM}** |
        | Python | `{sys.version.split()[0]}` |
        | duckdb | `{duckdb.__version__}` |
        """
    )
    return


@app.cell
def _():
    # DuckDB's own public sample database: 536 KB, one `stations` table of 578 rows.
    # `curl -I` on it returns `Access-Control-Allow-Origin: *` and `Accept-Ranges: bytes`,
    # so a browser has everything it needs to range-read it.
    DB_URL = "https://blobs.duckdb.org/databases/stations.duckdb"
    PROBE_SQL = "SELECT count(*) FROM probe.stations"

    # Our own lake, for the control probe that reproduces the original breakage.
    DUCKLAKE_URL = (
        "https://pub-003dd855abeb48a1927aa93a77fc5471.r2.dev/catalog.ducklake"
    )
    return DB_URL, DUCKLAKE_URL, PROBE_SQL


@app.cell
def _(time, traceback):
    def probe(name, fn):
        """Run one probe, capturing outcome instead of raising."""
        started = time.time()
        try:
            result = fn()
            ok, detail = True, repr(result)
        except BaseException:  # pyodide surfaces some failures as non-Exception
            ok = False
            detail = traceback.format_exc().strip().splitlines()[-1]
        return {
            "probe": name,
            "ok": ok,
            "seconds": round(time.time() - started, 2),
            "detail": detail[:300],
        }

    return (probe,)


@app.cell
def _(mo):
    mo.md(
        """
        ## Probe 1 — extensions

        Establishes the baseline failure. `httpfs` is what teaches DuckDB to read
        `https://` paths at all; `ducklake` is what the other notebooks attach.
        Both are extensions, so both are expected to fail under Pyodide.
        """
    )
    return


@app.cell
def _(duckdb, probe):
    def _load(ext):
        con = duckdb.connect()
        con.execute(f"INSTALL {ext}; LOAD {ext};")
        return f"{ext} loaded"

    extension_results = [
        probe("INSTALL+LOAD httpfs", lambda: _load("httpfs")),
        probe("INSTALL+LOAD ducklake", lambda: _load("ducklake")),
    ]
    extension_results
    return (extension_results,)


@app.cell
def _(mo):
    mo.md(
        """
        ## Probe 2 — direct ATTACH over https

        The interesting question. If DuckDB can range-read the remote file itself,
        we get lazy paging: only the pages a query touches cross the network.
        This needs an http filesystem, which in native DuckDB means httpfs.
        """
    )
    return


@app.cell
def _(DB_URL, DUCKLAKE_URL, PROBE_SQL, duckdb, probe):
    def _attach_remote():
        con = duckdb.connect()
        con.execute(f"ATTACH '{DB_URL}' AS probe (READ_ONLY)")
        return con.execute(PROBE_SQL).fetchone()

    def _attach_remote_after_httpfs():
        con = duckdb.connect()
        con.execute("INSTALL httpfs; LOAD httpfs;")
        con.execute(f"ATTACH '{DB_URL}' AS probe (READ_ONLY)")
        return con.execute(PROBE_SQL).fetchone()

    def _attach_ducklake():
        con = duckdb.connect()
        con.execute("INSTALL ducklake;")
        con.execute(f"ATTACH 'ducklake:{DUCKLAKE_URL}' AS probe (READ_ONLY)")
        return con.execute("SELECT count(*) FROM probe.parcels").fetchone()

    attach_results = [
        probe("ATTACH https (bare)", _attach_remote),
        probe("ATTACH https (after httpfs)", _attach_remote_after_httpfs),
        probe("ATTACH ducklake:https", _attach_ducklake),
    ]
    attach_results
    return (attach_results,)


@app.cell
def _(mo):
    mo.md(
        """
        ## Probe 3 — fetch the bytes, then ATTACH locally

        The fallback. Rather than asking DuckDB to speak HTTP, we let the *browser*
        fetch the file, drop it into Pyodide's in-memory filesystem, and hand DuckDB
        an ordinary local path. This trades laziness for a single upfront download
        of the whole file, so it only scales as far as the file is small.
        """
    )
    return


@app.cell
async def _(DB_URL, IS_WASM):
    async def fetch_bytes(url):
        if IS_WASM:
            from pyodide.http import pyfetch

            response = await pyfetch(url)
            return await response.bytes()
        import urllib.request

        with urllib.request.urlopen(url) as response:
            return response.read()

    try:
        db_bytes = await fetch_bytes(DB_URL)
        fetch_detail = f"{len(db_bytes):,} bytes"
    except BaseException as exc:
        db_bytes = None
        fetch_detail = f"fetch failed: {exc!r}"
    fetch_detail
    return (db_bytes, fetch_detail)


@app.cell
def _(PROBE_SQL, db_bytes, duckdb, probe):
    LOCAL_PATH = "/tmp/probe_copy.duckdb"

    def _attach_downloaded():
        if db_bytes is None:
            raise RuntimeError("no bytes to attach; the fetch above failed")
        with open(LOCAL_PATH, "wb") as handle:
            handle.write(db_bytes)
        con = duckdb.connect()
        con.execute(f"ATTACH '{LOCAL_PATH}' AS probe (READ_ONLY)")
        return con.execute(PROBE_SQL).fetchone()

    download_results = [probe("fetch -> local ATTACH", _attach_downloaded)]
    download_results
    return (download_results,)


@app.cell
def _(mo):
    mo.md("""## Results""")
    return


@app.cell
def _(
    IS_WASM,
    attach_results,
    download_results,
    extension_results,
    fetch_detail,
    mo,
):
    all_results = extension_results + attach_results + download_results

    def _row(r):
        mark = "PASS" if r["ok"] else "FAIL"
        return f"| {mark} | `{r['probe']}` | {r['seconds']}s | `{r['detail']}` |"

    summary = "\n".join(
        [
            f"Environment: **{'WASM / Pyodide' if IS_WASM else 'native CPython'}**",
            f"HTTP fetch of the .duckdb file: {fetch_detail}",
            "",
            "| | probe | time | detail |",
            "|---|---|---|---|",
            *[_row(r) for r in all_results],
        ]
    )

    # A machine-readable marker so a headless browser can scrape the verdict.
    verdict = ";".join(
        f"{r['probe']}={'PASS' if r['ok'] else 'FAIL'}" for r in all_results
    )

    mo.md(f"{summary}\n\n<pre id='probe-verdict'>PROBE_VERDICT {verdict}</pre>")
    return


if __name__ == "__main__":
    app.run()
