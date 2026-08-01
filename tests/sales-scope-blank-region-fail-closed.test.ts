import assert from "node:assert/strict";

import { computeSalesAccessScope } from "../src/lib/sales/access-scope.ts";
import { applyRegionScope } from "../src/lib/sales/monthly-closing-portal.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// Geography must not fail OPEN when nothing is known about the viewer's geography.
//
// `allowedRegionNames = null` means "no region restriction". The old expression was
//     regionScoped && canonicalRegion ? new Set([canonicalRegion]) : null
// so a region-scoped viewer whose region label was blank got NO geography bound and saw the whole
// product line.
//
// Scale, on the field the code actually reads (`employees.region_name` — NOT `region_code`, which
// the scope engine never consults): 1 of 17 District Sales Managers has a blank region_name, 0 of
// 74 Medical Representatives, 0 of 1 Regional Sales Managers. The one blank-region DM holds a seat
// owning 6 areas, so he takes the seat branch — nobody in production is currently fail-closed by
// this. It is a latent guard, verified 2026-08-01.
//
// The fix keeps every case that already worked and closes only "no region AND no seat areas".

const DM = "District Manager" as Parameters<typeof computeSalesAccessScope>[0]["role"];

function scopeFor(opts: { region?: string | null; areas?: string[] | null }) {
  return computeSalesAccessScope({
    role: DM,
    businessScope: "TEAM",
    viewerLineName: "CNS",
    viewerRegionName: opts.region ?? null,
    includeRestricted: false,
    seatAreaScope: opts.areas
      ? { areaCodes: new Set(opts.areas), factRegionCodes: new Set(["AB"]) }
      : null,
  } as Parameters<typeof computeSalesAccessScope>[0]);
}

export function runSalesScopeBlankRegionFailClosedTests() {
  // ── 1. Region known → bounded to that region (unchanged) ────────────────────
  {
    const scope = scopeFor({ region: "Cairo" });
    assert.ok(scope.allowedRegionNames, "a known region must still produce a bound");
    assert.equal(scope.allowedRegionNames.size, 1, "bounded to exactly the viewer's region");
  }

  // ── 2. Region blank BUT the seat answered → unchanged, areas are the bound ──
  // This is the common production case. The seat's areas may legitimately sit outside the region
  // label, so the region must stay unrestricted for them to be reachable at all.
  {
    const scope = scopeFor({ region: null, areas: ["AB1", "AB2", "D16"] });
    assert.equal(
      scope.allowedRegionNames,
      null,
      "with seat areas present the region must stay open, or an owned out-of-region area is filtered out",
    );
    assert.ok(scope.allowedAreaCodes, "the seat area bound must be carried");
    assert.equal(scope.allowedAreaCodes.size, 3, "all three owned areas");
  }

  // ── 3. Region blank AND no seat areas → FAIL CLOSED ─────────────────────────
  {
    const scope = scopeFor({ region: null, areas: null });
    assert.ok(
      scope.allowedRegionNames instanceof Set,
      "no geography at all must produce a SET, not null — null means 'see everything'",
    );
    assert.equal(
      scope.allowedRegionNames.size,
      0,
      "an empty set means no rows: showing a manager the whole line is worse than showing nothing",
    );
    assert.equal(scope.allowedAreaCodes, null, "and there is no area bound to fall back on");
  }

  // ── 4. An empty seat area set counts as NO geography, not as a bound ────────
  // A seat that resolved but owns nothing must not be mistaken for "seat answered".
  {
    const scope = scopeFor({ region: null, areas: [] });
    assert.ok(
      scope.allowedRegionNames instanceof Set && scope.allowedRegionNames.size === 0,
      "a seat with zero areas is not a geography bound — still fail closed",
    );
  }

  // ── 5. Company-wide viewers are untouched ───────────────────────────────────
  {
    const ceo = computeSalesAccessScope({
      role: "CEO",
      businessScope: "COMPANY",
      viewerLineName: null,
      viewerRegionName: null,
      includeRestricted: true,
    } as Parameters<typeof computeSalesAccessScope>[0]);
    assert.equal(ceo.allowedRegionNames, null, "a company-scope viewer must never be region-bounded");
    assert.equal(ceo.canViewAllSales, true, "and still sees everything");
  }

  // ── 6. The empty set must SURVIVE the consumer, not get widened back ────────
  //
  // Resolving a fail-closed scope is only half the job: the portal's applyRegionScope used to
  // treat "narrowed to nothing" as a data gap and fall back to the un-narrowed matrix. An empty
  // Set is truthy, so the engine's deliberate "no geography" answer cleared the null guard,
  // narrowed to zero regions, and was then handed straight back as the WHOLE LINE — re-opening
  // exactly what this change closes. These pin both halves of that distinction.
  {
    const matrix = buildScopeTestMatrix();

    const denied = applyRegionScope(matrix, new Set<string>(), null);
    assert.equal(
      denied.regions.length,
      0,
      "an explicitly empty region set means no geography ⇒ no rows, never the full line",
    );
    assert.equal(denied.grandTotal.rowTotal.salesValue, 0, "and the grand total is zeroed with it");

    // The data-gap fallback this guard exists for must still work: a NON-empty label that simply
    // matches no region in this matrix (e.g. the RM aggregate "Alexandria + Delta") still widens.
    const unmappable = applyRegionScope(matrix, new Set(["alexandria + delta"]), null);
    assert.equal(
      unmappable.regions.length,
      matrix.regions.length,
      "an unmappable region LABEL still falls back to the un-narrowed matrix, not a blank sheet",
    );

    // And a normal, resolvable bound still narrows to exactly that region.
    const bounded = applyRegionScope(matrix, new Set(["cairo"]), null);
    assert.deepEqual(bounded.regions.map((r) => r.regionCode), ["CA"], "a known region still narrows");

    // null (no restriction at all — company/line scope) is still pass-through.
    assert.equal(
      applyRegionScope(matrix, null, null).regions.length,
      matrix.regions.length,
      "null means unrestricted and must not be confused with the empty set",
    );
  }
}

// Minimal matrix fixture — mirrors tests/monthly-closing-region-scope.test.ts.
function scopeCell(salesValue: number, salesUnits: number): MonthlyClosingCell {
  return { salesUnits, salesValue, targetUnits: null, targetValue: null, achievement: null };
}

function scopeRegion(code: string, name: string) {
  const cells = [scopeCell(100, 10)];
  const rowTotal = scopeCell(100, 10);
  return {
    regionCode: code,
    regionName: name,
    areas: [
      {
        kind: "area" as const,
        areaCode: `${code}-A`,
        areaName: `${name} Area`,
        regionCode: code,
        regionName: name,
        cells,
        rowTotal,
      },
    ],
    subtotal: { kind: "regionSubtotal" as const, regionCode: code, regionName: name, cells, rowTotal },
  };
}

function buildScopeTestMatrix(): MonthlyClosingMatrix {
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-05"],
    columns: [{ family: "F", productCode: "P1", productName: "Prod 1" }],
    line: "Pedia",
    period: "2026-05",
    regions: [scopeRegion("AB", "Alex-BHR"), scopeRegion("CA", "Cairo")],
    grandTotal: { kind: "grandTotal", cells: [scopeCell(200, 20)], rowTotal: scopeCell(200, 20) },
    directNational: null,
    companyTotal: null,
  };
}
