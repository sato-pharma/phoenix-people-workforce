import assert from "node:assert/strict";

import { closingFileName, regionScopeLabel } from "../src/lib/sales/closing-export-filename.ts";

// The downloaded Monthly Closing workbook names its own scope: MONTH, LINE, REGION (owner's order).
//
// Before this, every export of every month and every line arrived as
// "phoenix-monthly-closing-anti-infective-2026-07.xlsx" — no region at all, and a raw period code
// where the sheets inside say "Jul 2026". Forward three of those and nobody can tell which is which
// without opening all three.

export function runClosingExportFilenameTests() {
  // ── Month, line, region — in that order. ───────────────────────────────────────────────────
  assert.equal(
    closingFileName({ line: "Anti Infective", period: "2026-07", region: "Delta (2)" }),
    "phoenix-monthly-closing-jul-2026-anti-infective-delta-2.xlsx",
    "month first, then line, then region — the owner's order",
  );
  assert.equal(
    closingFileName({ kind: "details", line: "Anti Infective", period: "2026-07", region: "Delta (2)" }),
    "phoenix-monthly-closing-details-jul-2026-anti-infective-delta-2.xlsx",
    "the row-level workbook stays distinguishable from the matrix export of the same scope",
  );

  // The file must agree with the sheets inside it, which are headed "Jul 2026", not "2026-07".
  assert.ok(
    closingFileName({ line: "Pedia", period: "2026-01", region: "Cairo" }).includes("jan-2026"),
    "the month is the same wording the sheets use, so the file and its contents never disagree",
  );
  assert.equal(
    closingFileName({ line: "Pedia", period: "2026-12", region: "Cairo" }),
    "phoenix-monthly-closing-dec-2026-pedia-cairo.xlsx",
    "December resolves to dec, not an off-by-one month",
  );

  // ── Region scope: one region names itself, several become "all regions". ───────────────────
  assert.equal(regionScopeLabel(["Delta (2)"]), "Delta (2)", "a single region names itself");
  assert.equal(
    regionScopeLabel(["Delta (2)", "Delta (2)", "Delta (2)"]),
    "Delta (2)",
    "one region repeated across many rows is still one region",
  );
  assert.equal(
    regionScopeLabel(["Delta (2)", "Alex-BHR"]),
    "all regions",
    "a workbook spanning two regions must not claim to be either of them",
  );
  assert.equal(
    regionScopeLabel([]),
    "all regions",
    "no rows is not a region — an empty export must never be named after one",
  );
  assert.equal(
    regionScopeLabel([null, undefined, "  "]),
    "all regions",
    "blank region labels are not a region name",
  );
  assert.equal(
    regionScopeLabel(["  Delta (2)  ", "Delta (2)"]),
    "Delta (2)",
    "whitespace does not make a second region",
  );

  // Short-circuit: the details workbook can carry tens of thousands of rows, so the second distinct
  // name must end the scan rather than materialising every row's region.
  let consumed = 0;
  function* manyRows() {
    for (const name of ["Delta (2)", "Alex-BHR", "Cairo", "Upper Egypt"]) {
      consumed += 1;
      yield name;
    }
  }
  assert.equal(regionScopeLabel(manyRows()), "all regions", "mixed regions resolve to all regions");
  assert.equal(consumed, 2, "the scan stops at the second distinct region instead of reading every row");

  // ── Nothing in a filename may be a raw code, and no segment may collapse to empty. ─────────
  assert.equal(
    closingFileName({ line: "", period: "", region: "" }),
    "phoenix-monthly-closing-all-all-all.xlsx",
    "empty inputs degrade to 'all' rather than producing '--.xlsx'",
  );
  assert.equal(
    closingFileName({ line: null, period: null, region: "all regions" }),
    "phoenix-monthly-closing-all-all-all-regions.xlsx",
    "null line/period never reach the filename as 'null'",
  );
  const name = closingFileName({ line: "Anti Infective", period: "2026-07", region: "Port said - Domiat" });
  assert.equal(
    name,
    "phoenix-monthly-closing-jul-2026-anti-infective-port-said-domiat.xlsx",
    "punctuation and spaces in a region name collapse to single hyphens",
  );
  assert.ok(
    /^[a-z0-9.-]+$/.test(name),
    "the whole filename is safe for a Content-Disposition header — no spaces, quotes or separators",
  );
}
