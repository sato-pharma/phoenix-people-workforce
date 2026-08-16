import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { MonthlyTargetRow } from "../src/lib/sales/monthly-targets.ts";
import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import {
  scopeMonthSalesRows,
  scopeMonthTargets,
  vsTargetVisibility,
  VS_TARGET_DISTRIBUTOR_REASON,
} from "../src/lib/sales/weekly/month-target-scope.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function target(overrides: Partial<MonthlyTargetRow> = {}): MonthlyTargetRow {
  return {
    period: "2026-08",
    lineCode: "pedia",
    areaCode: "AB1",
    productCode: "GU001",
    targetUnits: 100,
    targetValue: null,
    ...overrides,
  };
}

/** The Source-of-Sales area master: which region carries each area's target. */
const AREA_INDEX = new Map([
  ["AB1", { areaName: "Alexandria 1", regionCode: "AB" }],
  ["D11", { areaName: "Dakahlia 1", regionCode: "D1" }],
  ["CA1", { areaName: "Heliopolis", regionCode: "CA" }],
  ["GZ1", { areaName: "Dokki", regionCode: "GZ" }],
]);

const NO_FILTER = { values: [] as string[], mode: "include" as const };

const areasOf = (result: { targets: Array<{ areaCode: string }> }) =>
  result.targets.map((row) => row.areaCode).sort();

export async function runWeeklyMonthTargetScopeTests() {
  // ── The headline: a target is bounded by the SAME scope as the sales it divides ──
  //
  // phx_monthly_targets is SECURITY DEFINER and returns every line × every area for the period, so
  // without this the tab divided a Regional Manager's three regions of sales by the NATIONAL target
  // and printed every out-of-territory area as a named row carrying its real number.
  {
    const rows = [
      target({ areaCode: "AB1" }),
      target({ areaCode: "D11" }),
      target({ areaCode: "CA1" }),
      target({ areaCode: "GZ1" }),
    ];
    // The Pedia Regional Manager, bounded to Alex-BHR + Delta 1 + Delta 2 exactly as access.ts
    // resolves him from the seat map.
    const rm: WeeklyAccessScope = {
      tier: "territory",
      allowedLineNames: new Set(["Pedia"]),
      allowedRegionCodes: new Set(["AB", "D1", "D2"]),
      allowedAreaCodes: null,
      canViewHeadOffice: false,
    };
    const scoped = scopeMonthTargets({
      targets: rows,
      accessScope: rm,
      areaIndex: AREA_INDEX,
      line: NO_FILTER,
      region: NO_FILTER,
      product: NO_FILTER,
    });
    assert.deepEqual(
      areasOf(scoped),
      ["AB1", "D11"],
      "a territory viewer must receive ONLY his own regions' targets — Cairo and Giza are another manager's number",
    );
    assert.equal(
      scoped.droppedByAccessScope,
      2,
      "the two out-of-territory targets must be counted as withheld, not silently absent",
    );
    assert.deepEqual(scoped.targetedLines, ["Pedia"], "a line with real target units is reported as measured");
  }

  // A target row whose area the master cannot place has NO region, and applyWeeklyTerritoryScope
  // matches "" against nothing — so it fails CLOSED. That is the safe direction but it is invisible,
  // and an invisible drop reads as "no target was uploaded". It must be counted and named.
  {
    const scoped = scopeMonthTargets({
      targets: [target({ areaCode: "AB1" }), target({ areaCode: "ZZ9" })],
      accessScope: {
        tier: "territory",
        allowedLineNames: null,
        allowedRegionCodes: new Set(["AB"]),
        allowedAreaCodes: null,
        canViewHeadOffice: false,
      },
      areaIndex: AREA_INDEX,
      line: NO_FILTER,
      region: NO_FILTER,
      product: NO_FILTER,
    });
    assert.deepEqual(areasOf(scoped), ["AB1"], "an area missing from the master cannot be placed, so it fails closed");
    assert.deepEqual(
      scoped.unresolvedAreas,
      ["ZZ9"],
      "an unplaceable area must be NAMED, or the owner cannot tell a mapping gap from an empty target sheet",
    );
  }

  // ── Product tier: the target must narrow to his assigned products ──────────────
  //
  // This is why the tab reuses applyWeeklyAccessScope rather than the older line/area-keyed target
  // bounds in portal-targets.ts or vs-target-scope.ts: neither has a product concept at all, so a
  // Product Manager would have received every product's target behind his own products' sales.
  {
    const scoped = scopeMonthTargets({
      targets: [
        target({ areaCode: "AB1", productCode: "GU001" }),
        target({ areaCode: "D11", productCode: "SA001" }),
        target({ areaCode: "CA1", productCode: "LA003" }),
      ],
      accessScope: { tier: "product", productCodes: new Set(["GU001", "LA003"]), canViewHeadOffice: false },
      areaIndex: AREA_INDEX,
      line: NO_FILTER,
      region: NO_FILTER,
      product: NO_FILTER,
    });
    assert.deepEqual(
      areasOf(scoped),
      ["AB1"],
      "a product-scoped viewer gets only his assigned products' targets, and never the restricted Lacto Basic",
    );
  }

  // ── tier "none" returns nothing, not everything ───────────────────────────────
  {
    const scoped = scopeMonthTargets({
      targets: [target(), target({ areaCode: "CA1" })],
      accessScope: { tier: "none", canViewHeadOffice: false },
      areaIndex: AREA_INDEX,
      line: NO_FILTER,
      region: NO_FILTER,
      product: NO_FILTER,
    });
    assert.deepEqual(scoped.targets, [], "a viewer with no weekly scope must receive no targets at all");
    assert.equal(scoped.droppedByAccessScope, 2, "everything withheld is still everything counted");
  }

  // ── A line that is not a FIELD line carries no target and must never reach the tab ──
  //
  // Head Office is the case that matters. The two obvious guards both miss it: lineName() falls
  // through to the raw code for an unknown line, and isHeadOfficeLine() only lowercases — so it
  // recognises "Head Office" but NOT the "head_office" line CODE the engine speaks.
  {
    const scoped = scopeMonthTargets({
      targets: [target({ areaCode: "AB1" }), target({ areaCode: "CA1", lineCode: "head_office" })],
      accessScope: { tier: "full", canViewRestricted: true, canViewHeadOffice: false },
      areaIndex: AREA_INDEX,
      line: NO_FILTER,
      region: NO_FILTER,
      product: NO_FILTER,
    });
    assert.deepEqual(areasOf(scoped), ["AB1"], "a head_office target must never reach the tab, whatever the tier");
    assert.deepEqual(scoped.unrecognisedLines, ["head_office"], "the dropped line must be named, never silently gone");
  }

  // ── URL filters, in both polarities ───────────────────────────────────────────
  {
    const rows = [
      target({ areaCode: "AB1", lineCode: "pedia", productCode: "GU001" }),
      target({ areaCode: "CA1", lineCode: "cns", productCode: "SA001" }),
      target({ areaCode: "GZ1", lineCode: "anti_infective", productCode: "RO001" }),
    ];
    const open: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };
    const run = (over: Partial<Parameters<typeof scopeMonthTargets>[0]>) =>
      areasOf(
        scopeMonthTargets({
          targets: rows,
          accessScope: open,
          areaIndex: AREA_INDEX,
          line: NO_FILTER,
          region: NO_FILTER,
          product: NO_FILTER,
          ...over,
        }),
      );

    // The line filter is compared in CODE space on both sides. The URL carries a line NAME, and the
    // old inline version matched it against lineName(row.lineCode) — so it worked only while the two
    // spellings agreed. resolveTargetLineCode owns the alias table, so every real spelling lands.
    assert.deepEqual(run({ line: { values: ["Anti Infective"], mode: "include" } }), ["GZ1"], "official name matches");
    assert.deepEqual(run({ line: { values: ["anti-infective"], mode: "include" } }), ["GZ1"], "hyphen variant matches");
    assert.deepEqual(run({ line: { values: ["anti_infective"], mode: "include" } }), ["GZ1"], "raw line code matches");
    assert.deepEqual(run({ line: { values: ["Pedia"], mode: "exclude" } }), ["CA1", "GZ1"], "exclude drops that line");

    // Region is judged on the AREA's own region, so the tab's subtotals reconcile.
    assert.deepEqual(run({ region: { values: ["CA"], mode: "include" } }), ["CA1"], "region filter uses the area's region");
    assert.deepEqual(run({ region: { values: ["CA"], mode: "exclude" } }), ["AB1", "GZ1"], "exclude drops that region");

    assert.deepEqual(run({ product: { values: ["gu001"], mode: "include" } }), ["AB1"], "product filter is case-insensitive");
    assert.deepEqual(run({ product: { values: ["GU001"], mode: "exclude" } }), ["CA1", "GZ1"], "exclude drops that product");

    // "Asked for nothing" and "asked for something that resolves to nothing" must NOT collapse into
    // each other. Head Office resolves to no line code at all, so filtering to it must yield an
    // EMPTY tab — treating that empty key set as "no filter" would widen the sheet from the one line
    // he picked to every line he did not.
    assert.deepEqual(
      run({ line: { values: ["Head Office"], mode: "include" } }),
      [],
      "a filter that resolves to no line must show nothing, never widen to every line",
    );
    assert.deepEqual(
      run({ line: { values: ["Head Office"], mode: "exclude" } }),
      ["AB1", "CA1", "GZ1"],
      "excluding a line that resolves to nothing removes nothing",
    );
    assert.deepEqual(
      run({ product: { values: ["NOPE"], mode: "include" } }),
      [],
      "an unmatched product filter shows nothing, never everything",
    );
  }

  // ── Who gets the tab at all ───────────────────────────────────────────────────
  {
    assert.equal(vsTargetVisibility("District Manager", false).kind, "shown", "a District Manager gets the tab");
    assert.equal(vsTargetVisibility("Regional Manager", false).kind, "shown", "a Regional Manager gets the tab");
    assert.equal(vsTargetVisibility("CEO", false).kind, "shown", "the CEO gets the tab");
    assert.equal(vsTargetVisibility("Product Manager", false).kind, "shown", "a Product Manager gets the tab");

    // Owner's decision, 2026-08-16: managers only. A rep is measured on his own visits, not on an
    // area's whole monthly number.
    assert.equal(vsTargetVisibility("Medical Rep", false).kind, "hidden", "a Medical Rep must not get this tab");
    // Fail CLOSED: a role nobody has decided about yet gets nothing, not everything.
    assert.equal(vsTargetVisibility("Employee", false).kind, "hidden", "an undecided role gets no tab");
    assert.equal(vsTargetVisibility("Training Manager", false).kind, "hidden", "a non-sales role gets no tab");
    assert.equal(vsTargetVisibility("Finance Manager", false).kind, "hidden", "a non-sales role gets no tab");

    // A target belongs to an AREA, not to whoever delivered it, so it cannot be narrowed by
    // distributor — every percentage would be understated. The tab is withheld with the reason.
    const blocked = vsTargetVisibility("Regional Manager", true);
    assert.equal(blocked.kind, "blocked", "a distributor filter must suppress the tab, not caveat it");
    assert.equal(
      blocked.kind === "blocked" ? blocked.reason : "",
      VS_TARGET_DISTRIBUTOR_REASON,
      "the suppression must carry the owner's own wording",
    );
    // Role is checked FIRST — a rep gets no sheet rather than a sheet explaining a tab he never had.
    assert.equal(vsTargetVisibility("Medical Rep", true).kind, "hidden", "role outranks the filter check");
  }

  // ── Region symmetry on the SALES side ─────────────────────────────────────────
  //
  // The dashboard admits a row on the distributor BRANCH's region; the targets are admitted on the
  // AREA's region. They agree today only because resolveBranchArea refuses a mismatched mapping. The
  // moment they drift, area rows stop summing to the region row above them.
  {
    const rows = [
      { areaCode: "CA1", regionCode: "CA" }, // agrees
      { areaCode: "GZ1", regionCode: "CA" }, // DRIFT: branch says Cairo, the area belongs to Giza
      { areaCode: null, regionCode: "CA" }, // no area — the branch region is the only one it has
    ];
    const scoped = scopeMonthSalesRows(rows, AREA_INDEX, { values: ["CA"], mode: "include" });
    assert.deepEqual(
      scoped.rows.map((row) => row.areaCode),
      ["CA1", null],
      "an area belonging to another region must leave the Cairo filter, or the subtotals cannot reconcile",
    );
    assert.equal(scoped.droppedByRegionDrift, 1, "the drift must be counted");
    assert.deepEqual(scoped.driftAreas, ["Dokki"], "and the area NAMED, never its bare code");

    // With no region filter the function is a pass-through — it must never narrow on its own.
    const unfiltered = scopeMonthSalesRows(rows, AREA_INDEX, NO_FILTER);
    assert.equal(unfiltered.rows.length, 3, "with no region filter nothing may be dropped");
    assert.equal(unfiltered.droppedByRegionDrift, 0, "and nothing counted");
  }

  // ── The wiring, pinned at the source ──────────────────────────────────────────
  //
  // There are no route-handler tests in this repo — no auth or Supabase mock infrastructure exists.
  // The scoping itself is proven above; what a unit test cannot reach is whether the ROUTE actually
  // calls it. Pin that, because deleting the call is exactly the regression these tests exist for.
  {
    const route = readSource("../app/api/sales/weekly/summary-export/route.ts");
    assert.ok(
      route.includes("scopeMonthTargets("),
      "the summary export must scope its targets — phx_monthly_targets carries NO viewer bound of its own",
    );
    assert.ok(
      route.includes("vsTargetVisibility("),
      "the summary export must ask who may see the tab before building it",
    );
    assert.ok(
      !/loadMonthlyTargets\([^)]*\)\s*,?\s*$/m.test(route) || route.includes("catch"),
      "the target load must be guarded — it feeds one tab of six and must not take the workbook down",
    );

    // The bound must be the WEEKLY one, the same object the sales side used. The line/area-keyed
    // target bounds elsewhere in this repo have no product concept and would silently widen a
    // Product Manager's view.
    const scope = readSource("../src/lib/sales/weekly/month-target-scope.ts");
    assert.ok(
      scope.includes("applyWeeklyAccessScope("),
      "targets must go through the SAME predicate as the sales they are divided into",
    );
    assert.ok(
      !scope.includes("filterRowsForBound") && !scope.includes("filterAchievementForScope"),
      "the line/area-keyed target bounds must not be used here — they cannot express a product scope",
    );
  }
}
