#!/usr/bin/env bash
# Export the marimo notebooks in notebooks/ as WASM-powered HTML pages
# into site/, ready to publish as a static site (e.g. GitHub Pages).
#
# Each notebook becomes site/<name>/index.html, running entirely in the
# browser via Pyodide. A top-level site/index.html links to them all.
#
# Requires uv (https://docs.astral.sh/uv/). Usage:
#
#   scripts/build_site.sh
#   npx serve site   # or python3 -m http.server -d site
#
# Note: the exported pages must be served over HTTP; opening the files
# directly via file:// will not work.
set -euo pipefail

cd "$(dirname "$0")/.."

SITE_DIR=site
rm -rf "$SITE_DIR"
mkdir -p "$SITE_DIR"

links=""
for nb in notebooks/*.py; do
    name=$(basename "$nb" .py)
    echo "==> Exporting $nb -> $SITE_DIR/$name/"
    # --sandbox resolves the notebook's inline (PEP 723) dependencies in an
    # isolated uv environment. --mode run publishes a read-only app; code is
    # still viewable via --show-code.
    uvx marimo export html-wasm --sandbox --mode run --show-code -f \
        "$nb" -o "$SITE_DIR/$name"

    # Use the first line of the module docstring as the link title.
    title=$(python3 - "$nb" <<'EOF'
import ast, sys
doc = ast.get_docstring(ast.parse(open(sys.argv[1]).read()))
print(doc.splitlines()[0].rstrip(".") if doc else sys.argv[1])
EOF
    )
    links+="      <li><a href=\"$name/\">$title</a></li>\n"
done

cat > "$SITE_DIR/index.html" <<EOF
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Anchorage Parcel Lake — Notebooks</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.6; }
      a { color: #0b6e4f; }
    </style>
  </head>
  <body>
    <h1>Anchorage Parcel Lake — Notebooks</h1>
    <p>
      Interactive marimo notebooks exploring the
      <a href="https://github.com/NickCrews/anchorage-property">anchorage-parcel-lake</a>
      dataset. They run entirely in your browser via WebAssembly and query
      the public DuckLake over HTTPS — the first load takes a moment while
      Python boots.
    </p>
    <ul>
$(printf '%b' "$links")    </ul>
  </body>
</html>
EOF

# GitHub Pages: skip Jekyll processing so all exported assets are served as-is.
touch "$SITE_DIR/.nojekyll"

echo "==> Done. Preview with: python3 -m http.server -d $SITE_DIR"
