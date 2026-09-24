import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";

import { applyClosingAreaMergesToDetails } from "../src/lib/sales/closing-area-merges.ts";
import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";
import { closingAreaOf } from "../src/lib/sales/closing-row-area.ts";

/**
 * 🔴 THE ATTRIBUTION NET KEYS ON THE REAL AREA, NEVER ON THE DISPLAY FOLD.
 *
 * Pedia shows Fayoum (GZ6) and Beni Suef (UE9) as one row, "Fayoum - Beni Suef", and
 * `applyClosingAreaMergesToDetails` delivers that by rewriting a Beni Suef row's `sheetAreaCode`
 * to GZ6. Inside the closing that is self-consistent: the MATRIX folds the same pair, so the money
 * the split charges out of GZ6 and the row it lands on are the same row.
 *
 * `au.monthly_attribution_rollup` does NOT fold. It keys on the real area. So a net built from
 * folded rows charges Beni Suef's whole book OUT of Fayoum while attribution still credits Beni
 * Suef its own base — and Fayoum goes negative.
 *
 * 🔴 MEASURED LIVE ON 2026-09-09: Fayoum landed at −24.95 units against a base of 64. It was NOT
 * caused by the El Qema rule change that surfaced it — under the priority ladder the same defect
 * put Fayoum's net at −29.44 on the same base, which stayed positive and so was never seen. The
 * fix is `keepMergedAreasApart`, and this file is what stops a caller quietly losing it.
 *
 * 🔴 WHY THE LIST BELOW IS EXACT RATHER THAN A MINIMUM. A path that SHOULD fold and does not would
 * show one area's row split in two on a screen the owner reads as one. Both directions are silent,
 * so both are pinned: exactly the attribution-net builders pass it, and nothing else does.
 */

const REPO = resolve(import.meta.dirname, "..");

/** Every file that asks the details loader to keep Fayoum and Beni Suef apart. */
const KEEPS_AREAS_APART: readonly string[] = [
  "scripts/backfill-attribution-store-split.ts",
  "src/lib/sales/attribution-store-split-refresh.ts",
];

const SEARCH_ROOTS = ["src", "app", "scripts", "tests"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of cachedReaddir(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-")) continue;
    const full = join(dir, entry);
    if (cachedIsDirectory(full)) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

export function runMergedAreaAttributionTests() {
  // ── The fold really does rewrite the area the split reads ────────────────────────────────────
  //
  // This is the mechanism, asserted rather than described: without it a reader has to take the
  // rest of this file on trust, and the fix below looks like it is guarding nothing.
  const beniSuef = {
    areaCode: "UE9",
    areaName: "Beni Suef",
    sheetAreaCode: "UE9",
    sheetAreaName: "Beni Suef",
  };
  const [folded] = applyClosingAreaMergesToDetails("pedia", [{ ...beniSuef }], "2026-08");
  assert.equal(folded.sheetAreaCode, "GZ6", "the display fold rewrites Beni Suef's area to Fayoum's");
  assert.equal(folded.areaName, "Fayoum - Beni Suef", "and names the pair");
  assert.equal(
    closingAreaOf(folded),
    "GZ6",
    "so the split charges Beni Suef's sales OUT of Fayoum — the whole defect, in one line",
  );

  // Unfolded, the row keeps the area the attribution rollup actually holds it under.
  assert.equal(closingAreaOf(beniSuef), "UE9", "left alone, Beni Suef is Beni Suef");

  // A line with no merge rule is untouched either way, so the fix cannot leak sideways.
  const [alex] = applyClosingAreaMergesToDetails(
    "anti_infective",
    [{ areaCode: "UE9", areaName: "Beni Suef", sheetAreaCode: "UE9", sheetAreaName: "Beni Suef" }],
    "2026-08",
  );
  assert.equal(alex.sheetAreaCode, "UE9", "Anti Infective has no such rule and folds nothing");

  // ── The EXACT set of callers that keep the areas apart ───────────────────────────────────────
  const found = SEARCH_ROOTS
    .flatMap((root) => walk(join(REPO, root)))
    .filter((file) => /keepMergedAreasApart\s*:\s*true/.test(cachedReadFile(file)))
    .map((file) => relative(REPO, file).split("\\").join("/"))
    .filter((file) => !file.startsWith("tests/"))
    .sort();

  assert.deepEqual(
    found,
    [...KEEPS_AREAS_APART].sort(),
    "exactly the attribution-net builders keep Fayoum and Beni Suef apart — a new one is a "
      + "deliberate act, and a missing one puts a negative on a rep's area",
  );

  // The loader must still honour it, or the list above pins a flag that does nothing.
  const loader = cachedReadFile(join(REPO, "src/lib/sales/monthly-closing-details.ts"));
  assert.match(
    loader,
    /input\.keepMergedAreasApart === true\s*\n?\s*\?\s*mapped/,
    "the details loader skips the fold when asked, rather than accepting a flag it ignores",
  );
}
