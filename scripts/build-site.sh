#!/bin/sh
# Build every app into one static site, which is how they are deployed: WebUSB grants are
# per origin, so the flasher, the inspector, the workbench and the IDE example have to share
# one. The flasher is the site root; the others sit in subdirectories.
#
#   ./scripts/build-site.sh [base]     base defaults to / (use /probe-web/ for project Pages)
#
# Run scripts/build-wasm.sh first; this only bundles what is already built.
set -e
cd "$(dirname "$0")/.."
base=${1:-/}
out=$(pwd)/site

rm -rf "$out"
npx vite build apps/flash --base "$base" --outDir "$out" --emptyOutDir
for app in inspect:apps/inspect workbench:apps/workbench monaco-ide:examples/monaco-ide; do
  name=${app%%:*}
  dir=${app#*:}
  npx vite build "$dir" --base "$base$name/" --outDir "$out/$name" --emptyOutDir
done

# Pages serves this as-is; without it Jekyll drops files and directories beginning with _.
touch "$out/.nojekyll"
echo "site built in $out (base $base)"
