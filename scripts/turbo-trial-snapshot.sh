#!/usr/bin/env bash
# One-off helper for .github/workflows/turbopack-trial.yml. Not part of the product.
#
# Snapshots what a build put into .next/standalone, in the two forms that matter:
#   <name>.files    - every TRACED file (node_modules + assets), sorted. Deliberately EXCLUDES
#                     .next/standalone/.next/**, because bundler chunk names are hashed and differ
#                     between webpack and turbopack for reasons that say nothing about correctness.
#   <name>.manifest - presence/absence of the specific artefacts next.config.ts traces by hand.
#                     These are the ones that have actually broken production before (#2299).
set -uo pipefail
name="$1"
sa=".next/standalone"

if [ ! -d "$sa" ]; then
  echo "  $sa does not exist - build produced no standalone tree" | tee "/tmp/${name}.manifest"
  exit 0
fi

find "$sa" -type f \
  | grep -v "^${sa}/\.next/" \
  | sed "s|^${sa}/||" \
  | sort > "/tmp/${name}.files"

{
  echo "  standalone total files : $(find "$sa" -type f | wc -l)"
  echo "  traced files (compared): $(wc -l < "/tmp/${name}.files")"
  echo "  standalone total bytes : $(du -sb "$sa" | cut -f1)"
  echo ""
  check() {
    local label="$1"; shift
    local n
    n=$(find "$sa" -path "$1" 2>/dev/null | wc -l)
    if [ "$n" -gt 0 ]; then echo "  OK      $label  ($n)"; else echo "  MISSING $label"; fi
  }
  check "server.js"                       "${sa}/server.js"
  check "@napi-rs/canvas at HOISTED root" "${sa}/node_modules/@napi-rs/canvas/index.js"
  check "@napi-rs canvas .node binary"    "${sa}/node_modules/**/@napi-rs/canvas-linux*/*.node"
  check "pdfjs pdf.worker.mjs"            "${sa}/node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
  check "tessdata *.traineddata.gz"       "${sa}/assets/tessdata/*.traineddata.gz"
  check "brand assets *.png"              "${sa}/assets/brand/*.png"
  check "tesseract.js worker-script"      "${sa}/node_modules/.pnpm/tesseract.js@*/node_modules/tesseract.js/src/worker-script/*"
  check "tesseract.js-core"               "${sa}/node_modules/.pnpm/tesseract.js-core@*/node_modules/tesseract.js-core/*"
} | tee "/tmp/${name}.manifest"
