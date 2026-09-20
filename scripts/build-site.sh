#!/bin/sh
# Build the deployed static site: the documentation at the root, and the apps beside it.
# WebUSB grants are per origin, so the flasher, the inspector, the workbench and the examples
# share one; each sits in its own directory.
#
#   ./scripts/build-site.sh [base]     base defaults to / (use /probe-web/ for project Pages)
#
#   <base>                docs (VitePress, with the TypeDoc API reference under api/)
#   <base>flash/          the flasher
#   <base>workbench/      the workbench
#   <base>inspect/        the inspector
#   <base>monaco-ide/     the Monaco IDE example
#   <base>minimal-flash/  the minimal flashing example
#   <base>react-flash/    the React example
#   <base>firmware/, *.json, svd/, targets/   demo firmware, manifests and data the apps load
#
# Run scripts/build-wasm.sh first (and scripts/build-firmware.sh for the demo images); this
# only bundles what is already built.
set -e
cd "$(dirname "$0")/.."
base=${1:-/}
out=$(pwd)/site

# @probe-web/ui ships compiled JS: the apps resolve it through its dist/, the same way an
# npm consumer does, so it has to exist before Vite runs.
npm run build -w @probe-web/ui

# One build for every app (vite.site.config.ts), so the 10 MB worker and the client wasm
# are emitted once and shared instead of once per app.
npx vite build --config vite.site.config.ts --base "$base"

# Vite writes each entry's HTML under its source path; move them where they are served from.
# Asset URLs inside are absolute (they start with `base`), so moving the files is safe.
for app in flash:apps/flash inspect:apps/inspect workbench:apps/workbench \
  monaco-ide:examples/monaco-ide minimal-flash:examples/minimal-flash \
  react-flash:examples/react-flash; do
  mkdir -p "$out/${app%%:*}"
  mv "$out/${app#*:}/index.html" "$out/${app%%:*}/index.html"
done
rm -rf "$out/apps" "$out/examples"

# The docs own the root: index.html, guide/, reference/, api/ and their hashed assets.
npm run docs:api
DOCS_BASE="$base" npx vitepress build docs --outDir "$out/.docs"
cp -R "$out/.docs/." "$out/"
rm -rf "$out/.docs"

# Pages serves this as-is; without it Jekyll drops files and directories beginning with _.
touch "$out/.nojekyll"
echo "site built in $out (base $base)"
