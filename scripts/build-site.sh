#!/bin/sh
# Build every app into one static site, which is how they are deployed: WebUSB grants are
# per origin, so the flasher, the inspector, the workbench and the IDE example have to share
# one. The flasher is the site root; the others sit in subdirectories.
#
#   ./scripts/build-site.sh [base]     base defaults to / (use /probe-web/ for project Pages)
#
# Run scripts/build-wasm.sh first (and scripts/build-firmware.sh for the demo images); this
# only bundles what is already built.
set -e
cd "$(dirname "$0")/.."
base=${1:-/}
out=$(pwd)/site

# One build for all four apps (vite.site.config.ts), so the 12.6 MB worker and the client wasm
# are emitted once and shared instead of once per app.
npx vite build --config vite.site.config.ts --base "$base"

# Vite writes each entry's HTML under its source path; move them where they are served from.
# Asset URLs inside are absolute (they start with `base`), so moving the files is safe.
mv "$out/apps/flash/index.html" "$out/index.html"
for app in inspect:apps/inspect workbench:apps/workbench monaco-ide:examples/monaco-ide; do
  mkdir -p "$out/${app%%:*}"
  mv "$out/${app#*:}/index.html" "$out/${app%%:*}/index.html"
done
rm -rf "$out/apps" "$out/examples"

# Pages serves this as-is; without it Jekyll drops files and directories beginning with _.
touch "$out/.nojekyll"
echo "site built in $out (base $base)"
