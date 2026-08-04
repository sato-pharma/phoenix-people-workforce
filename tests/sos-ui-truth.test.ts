import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two ways the screen lied about its own numbers.
//
// 1. BRICK COVERAGE. `bricksReached` was `new Set(brickRows.map(r => r.brickId)).size` and
//    `totalBricks` was the SAME expression, so "bricks reached / total bricks" was mathematically
//    always 100%: only bricks that had sales were ever counted as bricks that exist. The KPI could
//    not report a gap, which is the only thing it is for.
//
// 2. EXPORT PARITY. The Monthly Closing workbook was always the full national matrix while the
//    screen showed a region/area/product-filtered one, because handleExport posted only
//    { line, period }. Exporting "what I am looking at" produced different numbers.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

export function runSosUiTruthTests() {
  // ── 1. Brick coverage has a real master denominator ─────────────────────────
  {
    const dashboard = code(read("src/lib/sales/sos-dashboard.ts"));

    assert.ok(
      !/totalBricks:\s*new Set\(brickRows/.test(dashboard),
      "totalBricks must not be derived from brickRows — that is the numerator, so coverage is always 100%",
    );
    assert.match(
      dashboard,
      /const masterBricks = \(references\.bricks \?\? \[\]\)/,
      "the brick denominator must come from the brick MASTER, not from rows that had sales",
    );
    assert.match(dashboard, /const totalBricks = masterBricks\.length;/, "totalBricks = master count");

    // The denominator must be scoped like masterAreas: a seat-scoped viewer measures against their
    // own areas, otherwise against their regions. An unscoped denominator makes a DM's coverage
    // look catastrophic against the whole company's bricks.
    const masterBricksBlock = dashboard.slice(
      dashboard.indexOf("const masterBricks"),
      dashboard.indexOf("const totalBricks = masterBricks.length;"),
    );
    assert.match(masterBricksBlock, /scopeAreaCodes/, "brick denominator must honour the seat area bound");
    assert.match(masterBricksBlock, /scopeRegionCodes/, "brick denominator must honour the region bound");

    // Numerator unchanged: distinct bricks that actually sold.
    assert.match(dashboard, /bricksReached: soldBrickIds\.size/, "numerator stays 'bricks that sold'");
  }

  // ── 2. The closing export carries the on-screen filter ──────────────────────
  {
    const workspace = code(read("src/components/sales/monthly-closing-workspace.tsx"));
    // Scope to handleExport only. The neighbouring publish call posts line+period and SHOULD —
    // publishing is a per-(line, period) act and has no filter.
    const exportStart = workspace.indexOf("async function handleExport()");
    assert.ok(exportStart >= 0, "handleExport must exist");
    const exportBody = workspace.slice(exportStart, exportStart + 1400);

    assert.ok(
      !/body: JSON\.stringify\(\{ line: selectedLine, period: selectedPeriod \}\)/.test(exportBody),
      "the export must not post line+period only — that is how the workbook diverged from the screen",
    );
    for (const field of ["areaCodes", "regionCodes", "productCodes", "search"]) {
      assert.ok(
        new RegExp(`${field}:\\s*filter\\.${field}`).test(exportBody),
        `the export body must carry filter.${field}`,
      );
    }

    const route = code(read("app/api/sales/monthly-closing/export/route.ts"));
    // The invariant is that the loaded matrix is narrowed by the caller's own `matrixFilter`
    // through the same pure function the table uses — NOT what the loaded matrix is called. The
    // identifier was pinned literally once and broke when the loader started returning the
    // channel parts (`parts.combined`) rather than a bare `fullMatrix`, which changed no behaviour.
    assert.match(
      route,
      /filterMonthlyClosingMatrix\([A-Za-z0-9_.]+, matrixFilter\)/,
      "the route must apply the SAME pure filter the table uses, so the two cannot diverge",
    );
    // Narrowing only — the filter must never be able to widen what a caller may see.
    assert.match(
      route,
      /const matrix = filterMonthlyClosingMatrix\(/,
      "the workbook must be built from the FILTERED matrix",
    );
  }
}
