import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { closingFileName, coversOneRegion, regionScopeLabel } from "../src/lib/sales/closing-export-filename.ts";

// The downloaded Monthly Closing workbook names its own scope (owner, 2026-10-20: "when exporting it
// by region, manager-region-type; if the total sheet, then line name-month-type").
//
//   one region   <manager>-<region>-<type>-<month>     (the month is kept so a reader's several months differ)
//   the total    <line>-<month>-<type>
//
// Before this, every export arrived as "phoenix-monthly-closing-<month>-<line>-<region>.xlsx": the
// manager who runs the region was nowhere in it, so forwarding three regions' files meant opening each.

export function runClosingExportFilenameTests() {
  // ── One region: manager, region, type, month. ─────────────────────────────────────────────
  assert.equal(
    closingFileName({ line: "Anti Infective", manager: "Mohamed Ali", period: "2026-07", region: "Delta (2)" }),
    "mohamed-ali-delta-2-monthly-closing-jul-2026.xlsx",
    "a region's file leads with the manager who runs it, then the region, the type and the month",
  );
  assert.equal(
    closingFileName({ kind: "details", line: "Anti Infective", manager: "Mohamed Ali", period: "2026-07", region: "Delta (2)" }),
    "mohamed-ali-delta-2-monthly-closing-details-jul-2026.xlsx",
    "the row-level workbook stays distinguishable from the matrix export of the same scope — the type carries it",
  );
  assert.equal(
    closingFileName({ line: "Pedia", period: "2026-12", region: "Cairo" }),
    "cairo-monthly-closing-dec-2026.xlsx",
    "no manager can be named: the region leads, never a blank or a code, and December is dec",
  );
  assert.equal(
    closingFileName({ line: "Pedia", manager: "   ", period: "2026-12", region: "Cairo" }),
    "cairo-monthly-closing-dec-2026.xlsx",
    "a blank manager names no one",
  );

  // ── The total: line, month, type. ─────────────────────────────────────────────────────────
  assert.equal(
    closingFileName({ line: "Anti Infective", period: "2026-07", region: "all regions" }),
    "anti-infective-jul-2026-monthly-closing.xlsx",
    "a workbook spanning several regions is the line's total: line name, month, type",
  );
  assert.equal(
    closingFileName({ extension: "xlsm", kind: "premium", line: "CNS", period: "2026-07", region: "all regions" }),
    "cns-jul-2026-monthly-closing-premium.xlsm",
    "the premium total keeps its type and its extension",
  );
  assert.equal(
    closingFileName({ line: "Anti Infective", manager: "Mohamed Ali", period: "2026-07", region: "all regions" }),
    "anti-infective-jul-2026-monthly-closing.xlsx",
    "a manager handed to a total workbook is ignored — it covers no single region",
  );

  // The file must agree with the sheets inside it, which are headed "Jul 2026", not "2026-07".
  assert.ok(
    closingFileName({ line: "Pedia", period: "2026-01", region: "Cairo" }).includes("jan-2026"),
    "the month is the same wording the sheets use, so the file and its contents never disagree",
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
  assert.equal(coversOneRegion("Delta (2)"), true, "a named region is one region");
  assert.equal(coversOneRegion("all regions"), false, "the all-regions label is not one");
  assert.equal(coversOneRegion("  ALL REGIONS "), false, "case and spacing do not make it one");
  assert.equal(coversOneRegion(""), false, "a blank region is not one");

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
    "all-all-monthly-closing.xlsx",
    "empty inputs degrade to 'all' rather than producing '--.xlsx'",
  );
  assert.equal(
    closingFileName({ line: null, period: null, region: "all regions" }),
    "all-all-monthly-closing.xlsx",
    "null line/period never reach the filename as 'null'",
  );
  const name = closingFileName({ line: "Anti Infective", manager: "Ahmed O'Neil", period: "2026-07", region: "Port said - Domiat" });
  assert.equal(
    name,
    "ahmed-o-neil-port-said-domiat-monthly-closing-jul-2026.xlsx",
    "punctuation and spaces in a name collapse to single hyphens",
  );
  assert.ok(
    /^[a-z0-9.-]+$/.test(name),
    "the whole filename is safe for a Content-Disposition header — no spaces, quotes or separators",
  );

  // ── Every Monthly Closing workbook route names its file through the one resolver. ──────────
  for (const file of [
    "app/api/sales/monthly-closing/export/route.ts",
    "app/api/sales/monthly-closing/premium-export/route.ts",
    "app/api/sales/monthly-closing/rep-ranking-export/route.ts",
    "src/lib/sales/closing-consolidated-premium-export.ts",
    "src/lib/sales/monthly-closing-consolidated-export.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /await resolveClosingFileName\(\{/, `${file} names its file through resolveClosingFileName`);
    assert.doesNotMatch(source, /(^|[^e])closingFileName\(\{/m, `${file} never builds a name without asking who runs the region`);
  }
  const resolver = readFileSync("src/lib/sales/closing-export-file-name.ts", "utf8");
  assert.match(resolver, /if \(coversOneRegion\(region\)\)/, "a workbook spanning several regions asks the organogram for no manager");
}
