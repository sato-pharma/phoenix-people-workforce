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
    // Scope to the function that actually issues the export request. The neighbouring publish call
    // posts line+period and SHOULD — publishing is a per-(line, period) act and has no filter.
    //
    // That function is `runExport`, not `handleExport`, since 2026-08-30: the screen grew a SECOND
    // export button (the premium workbook, added beside the original rather than replacing it), and
    // the two share one request body precisely so they cannot drift apart. This pin followed the
    // body rather than the old function name — the invariant was never "handleExport contains a
    // fetch", it is "what the export posts is what the screen is showing".
    const exportStart = workspace.indexOf("async function runExport(");
    assert.ok(exportStart >= 0, "runExport must exist — it is the one place an export request is built");
    // Bound it by its own closing brace at this indent — a real end of function, not a byte window.
    const exportEnd = workspace.slice(exportStart).search(/^  \}$/m);
    const exportBody = workspace.slice(exportStart, exportEnd >= 0 ? exportStart + exportEnd : workspace.length);

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

    // BOTH buttons must go through it. A second button that built its own request is exactly how
    // one of the two workbooks would quietly start covering the whole line while the screen showed
    // one region — the divergence this whole section exists to prevent, reintroduced by a copy.
    for (const handler of ["handleExport", "handlePremiumExport"]) {
      const start = workspace.indexOf(`async function ${handler}()`);
      assert.ok(start >= 0, `${handler} must exist`);
      const end = workspace.slice(start).search(/^  \}$/m);
      const body = workspace.slice(start, end >= 0 ? start + end : workspace.length);
      assert.match(body, /await runExport\(\{/, `${handler} must build its request through runExport, never its own`);
      assert.ok(!/fetch\(/.test(body), `${handler} must not issue its own fetch`);
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

  // ── 3. The macro-free workbook is reachable from the screen ─────────────────
  //
  // IT WAS NOT, for as long as the macro-free build existed. The route has honoured `macros: false`
  // since that build shipped, but this screen never sent it: the string appeared in the component
  // exactly ONCE, inside a comment describing the option. Every download was the .xlsm, and the only
  // way to obtain the .xlsx was to call the API by hand. A capability nothing can reach is
  // indistinguishable from one that was never built, and neither a type nor a route test can see it.
  //
  // Pinned on the COMMENT-STRIPPED source, which is the whole point — a grep for `macros: false`
  // passed throughout the period the option was unreachable, because prose satisfied it.
  {
    const workspace = code(read("src/components/sales/monthly-closing-workspace.tsx"));

    assert.match(
      workspace,
      /macros:\s*false/,
      "the closing screen must actually SEND macros:false — a comment mentioning it is not a button",
    );
    assert.match(
      workspace,
      /async function handlePremiumXlsxExport\(/,
      "the macro-free export needs its own handler, so its busy state cannot be confused with the .xlsm's",
    );
    assert.match(
      workspace,
      /onClick=\{\(\) => void handlePremiumXlsxExport\(\)\}/,
      "and that handler must be wired to a button a reader can press",
    );
    // The .xlsm button is the one that must not quietly become the macro-free one: they are two
    // formats for two audiences, and the owner asked for both to stay available.
    assert.match(
      workspace,
      /onClick=\{\(\) => void handlePremiumExport\(\)\}/,
      "the .xlsm export stays — the macro build is the one with a live button bar",
    );
  }
}
