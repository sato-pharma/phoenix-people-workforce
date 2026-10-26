import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildClosingPerformanceReview,
  PERFORMANCE_REVIEW_MONTHS,
  selectSeriesPeriods,
  type AreaSeatAssignment,
} from "../src/lib/sales/closing-performance-review.ts";
import {
  canOpenClosingPerformanceReview,
  canOpenPortalClosingPerformanceReview,
  PORTAL_PERFORMANCE_REVIEW_ROLES,
} from "../src/lib/sales/closing-performance-review-access.ts";
import {
  PERFORMANCE_REVIEW_FIRST_PERIOD,
  reviewShowsLessThanTheWholeLine,
  reviewTotalRowLabel,
} from "../src/lib/sales/closing-performance-review-regions.ts";
import {
  boundPeriodsToPublished,
  narrowMatrixToViewerScope,
  reviewScopeIsBounded,
  viewerBoundNarrowsTheLine,
  type PerformanceReviewViewerScope,
} from "../src/lib/sales/closing-performance-review-scope.ts";
import { scopeLabel } from "../src/lib/sales/closing-performance-review-export.ts";
import { monthlyClosingFilterOptions } from "../src/lib/sales/monthly-closing-filter-options.ts";
import { blankOut } from "./support/page-gate-reader.ts";
import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// EACH SALES MANAGER READS THE PERFORMANCE REVIEW OVER HIS OWN TERRITORY, AND OVER HIS PUBLISHED
// MONTHS FROM JULY UPWARD.
//
// Owner, 2026-10-13: "show performance review tab in each district manager account … and of course,
// everyone sees only his scope", and — correcting the floor the same day — "no show performance
// review in emp portal starting from july". So the series floor stays
// `PERFORMANCE_REVIEW_FIRST_PERIOD` ("2026-07") for every reader, and "the history" is the published
// months above it.
//
// Four things here can each ship a perfectly plausible screen that is wrong:
//
//  (1) THE BOUND CAN BE INVISIBLE TO A COUNT. A bounded viewer's pickers are built from his OWN
//      areas, so "rows surviving" equals "rows offered" and the filtered-view detector reports the
//      whole line — printing NATIONAL TOTAL over four areas of fifty-eight. That is the exact false
//      claim the 2026-10-09 rule was written to stop, arriving through a new door.
//  (2) AN UNRESOLVED GEOGRAPHY CAN FAIL OPEN. A manager whose seat answers nothing must see NO rows,
//      never the line — the one failure mode that hands a district manager the company's ranking.
//  (3) A CONFIDENTIAL COLUMN CAN RIDE IN. The review re-cuts the matrix; the restricted products are
//      stripped per viewer, not per line, so the strip has to be inside the scope narrowing.
//  (4) AN UNPUBLISHED MONTH CAN LEAK. The bounded list is the manager's PUBLISHED months, floored at
//      July — falling back to the closing's own list would offer him months nobody has published.

const COLUMNS: MonthlyClosingColumn[] = [
  { family: "Tebofortin", productCode: "TB001", productName: "Tebofortin 40mg" },
  { family: "Tebofortin", productCode: "TB002", productName: "Tebofortin 80mg" },
  // Restricted (LA003/LA004/SS001 — CEO and Super Admin only). Present on purpose: a scoped read
  // must drop it, and a fixture without it could not tell whether the strip ran.
  { family: "Satoslim", productCode: "SS001", productName: "Satoslim" },
];

function cell(salesUnits: number, salesValue: number, targetValue: number | null): MonthlyClosingCell {
  return {
    achievement: targetValue == null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: null,
    targetValue,
  };
}

function total(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  let salesUnits = 0;
  let salesValue = 0;
  let targetValue: number | null = null;
  for (const entry of cells) {
    salesUnits += entry.salesUnits;
    salesValue += entry.salesValue;
    if (entry.targetValue != null) targetValue = (targetValue ?? 0) + entry.targetValue;
  }
  return {
    achievement: targetValue == null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: null,
    targetValue,
  };
}

function areaRow(
  regionCode: string,
  regionName: string,
  areaCode: string,
  areaName: string,
  cells: MonthlyClosingCell[],
): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells, kind: "area", regionCode, regionName, rowTotal: total(cells) };
}

/** Two regions, three areas — one of them the district under test. */
function matrixFor(period: string): MonthlyClosingMatrix {
  const cairo1 = areaRow("CA", "Cairo", "CA1", "Cairo 1", [
    cell(100, 5_000, 6_000),
    cell(40, 3_000, 2_000),
    cell(10, 900, 1_000),
  ]);
  const cairo2 = areaRow("CA", "Cairo", "CA2", "Cairo 2", [
    cell(60, 2_400, 3_000),
    cell(20, 1_200, 1_500),
    cell(5, 400, 500),
  ]);
  const dakahlia = areaRow("DL", "Delta", "D21", "Dakahlia 1", [
    cell(30, 1_500, 1_800),
    cell(0, 0, null),
    cell(4, 260, 300),
  ]);

  const cairoAreas = [cairo1, cairo2];
  const cairoCells = COLUMNS.map((_column, index) => total(cairoAreas.map((row) => row.cells[index])));
  const grandCells = COLUMNS.map((_column, index) =>
    total([...cairoAreas, dakahlia].map((row) => row.cells[index])),
  );

  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-01", "2026-08", "2026-09"],
    columns: COLUMNS,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: total(grandCells) },
    line: "CNS",
    period,
    regions: [
      {
        areas: cairoAreas,
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: {
          cells: cairoCells,
          kind: "regionSubtotal",
          regionCode: "CA",
          regionName: "Cairo",
          rowTotal: total(cairoCells),
        },
      },
      {
        areas: [dakahlia],
        regionCode: "DL",
        regionName: "Delta",
        subtotal: {
          cells: dakahlia.cells,
          kind: "regionSubtotal",
          regionCode: "DL",
          regionName: "Delta",
          rowTotal: dakahlia.rowTotal,
        },
      },
    ],
  };
}

const SEATS = new Map<string, AreaSeatAssignment>([
  ["cns::CA1", { managerName: "Hany Adel", repIsVacant: false, repName: "Mostafa Kamel" }],
  ["cns::CA2", { managerName: "Hany Adel", repIsVacant: false, repName: "Nour Hassan" }],
  ["cns::D21", { managerName: "Sherif Nabil", repIsVacant: false, repName: "Amr Fathy" }],
]);

/** A district manager holding Cairo 1 and Cairo 2 by his seat, with no product bound. */
const DISTRICT_SCOPE: PerformanceReviewViewerScope = {
  allowedLines: ["CNS"],
  areaCodes: new Set(["CA1", "CA2"]),
  line: "CNS",
  productCodes: null,
  regionNames: null,
};

/** Built exactly as the loader builds one: scope the matrix, derive the options from the SCOPED one. */
function reviewFor(scope: PerformanceReviewViewerScope | null) {
  const unscoped = matrixFor("2026-09");
  const headline = narrowMatrixToViewerScope(unscoped, scope);
  return buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-09", "2026-08", "2026-01"],
    filterOptions: monthlyClosingFilterOptions(headline),
    generatedAt: "2026-10-13T09:00:00.000Z",
    matrix: headline,
    // The loader's own predicate, not a copy of it.
    scopeIsBounded: reviewScopeIsBounded(unscoped, scope),
    seatAssignments: SEATS,
    seriesMatrices: [{ matrix: headline, period: "2026-09" }],
  });
}

function access(role: PhoenixRole): AccessContext {
  return { hrId: "B-99", loginId: "B-99", permissions: {}, role, scope: "self" } as unknown as AccessContext;
}

export async function runClosingPerformanceReviewManagerScopeTests() {
  // ── (1) The bound narrows the rows, and the totals are re-derived from what survives ──────────
  const scoped = narrowMatrixToViewerScope(matrixFor("2026-09"), DISTRICT_SCOPE);
  assert.deepEqual(
    scoped.regions.flatMap((group) => group.areas.map((area) => area.areaCode)),
    ["CA1", "CA2"],
    "a district manager's matrix holds his own areas and nothing else",
  );
  // 5,000 + 3,000 + 2,400 + 1,200 — his two areas, with the restricted column's money excluded
  // because that column is gone rather than zeroed.
  assert.equal(
    scoped.grandTotal.rowTotal.salesValue,
    11_600,
    "the grand total is re-derived from the surviving rows, never carried over from the line",
  );

  // ── (2) A confidential column cannot ride in on a scoped read ────────────────────────────────
  assert.ok(
    !scoped.columns.some((column) => column.productCode === "SS001"),
    "the restricted product column is stripped for a portal viewer, inside the scope narrowing",
  );

  // ── (3) A GEOGRAPHY THAT MATCHES NOTHING ⇒ NO ROWS. Never the whole line, never his whole region ─
  //
  // 🔴 THREE SHAPES, AND ONLY THE FIRST USED TO FAIL CLOSED. The shared `applyRegionScope` reads "my
  // bound matched nothing in THIS matrix" as a data gap and hands back the UN-narrowed matrix, which
  // on this sheet means every rep in the company ranked by name — labelled "own territory" by
  // `scopeIsBounded`, because the bound was non-empty. Three live shapes reach it: the one
  // blank-region District Manager whose seat owns six areas, any seat whose areas are absent from a
  // published month, and the 26 employees labelled "Upper Egypt" against Anti Infective's "Upper
  // Egypt 1"/"Upper Egypt 2" groups. So the review narrows with NO fallback.
  const unresolved = narrowMatrixToViewerScope(matrixFor("2026-09"), {
    ...DISTRICT_SCOPE,
    areaCodes: new Set<string>(),
    regionNames: new Set<string>(),
  });
  assert.equal(
    unresolved.regions.length,
    0,
    "a manager whose geography resolved to nothing sees no rows — failing open would hand him the company",
  );
  const areasMissThisMonth = narrowMatrixToViewerScope(matrixFor("2026-09"), {
    ...DISTRICT_SCOPE,
    areaCodes: new Set(["CA9"]),
    regionNames: null,
  });
  assert.equal(
    areasMissThisMonth.regions.length,
    0,
    "a seat whose areas are absent from this month's matrix sees no rows, never the whole line",
  );
  assert.equal(
    areasMissThisMonth.grandTotal.rowTotal.salesValue,
    0,
    "and its grand total is zero rather than the line's — a widened total is the figure he would quote",
  );
  const regionLabelMissesTheGroup = narrowMatrixToViewerScope(matrixFor("2026-09"), {
    ...DISTRICT_SCOPE,
    areaCodes: null,
    regionNames: new Set(["upper egypt"]),
  });
  assert.equal(
    regionLabelMissesTheGroup.regions.length,
    0,
    "a region label that matches no group on this line sees no rows — the Upper Egypt 1/2 shape",
  );
  const seatMissFallsBackToNoRegion = narrowMatrixToViewerScope(matrixFor("2026-09"), {
    ...DISTRICT_SCOPE,
    areaCodes: new Set(["CA9"]),
    regionNames: new Set(["cairo"]),
  });
  assert.equal(
    seatMissFallsBackToNoRegion.regions.length,
    0,
    "a seat miss is not widened to his whole region either — that is every sibling district in it",
  );
  // The bound that DOES bite is untouched by all of this: this is a fail-closed change, not a
  // narrower one. (1) above already proves his two areas survive with their own total.
  assert.equal(
    narrowMatrixToViewerScope(matrixFor("2026-09"), { ...DISTRICT_SCOPE, areaCodes: null, regionNames: new Set(["cairo"]) })
      .regions.flatMap((group) => group.areas.map((area) => area.areaCode))
      .join(","),
    "CA1,CA2",
    "a regional manager whose label DOES match still reads his region",
  );

  // ── (4) THE TOTAL ROW NEVER CLAIMS TO BE NATIONAL ON A BOUNDED VIEW, WITH NO FILTER SET ──────
  const districtReview = reviewFor(DISTRICT_SCOPE);
  assert.equal(districtReview.scopeIsBounded, true, "the payload carries the bound");
  assert.equal(
    districtReview.areas.length,
    districtReview.filterOptions.areas.length,
    "the trap: his surviving rows EQUAL his offered options, so no count can detect the narrowing",
  );
  assert.ok(
    reviewShowsLessThanTheWholeLine(districtReview),
    "a bounded view shows less than the whole line even though the counts agree",
  );
  assert.equal(
    reviewTotalRowLabel(districtReview),
    "Filtered total",
    "a district manager's bottom row is a FILTERED total — \"National total\" over his district is false",
  );
  // And the workbook's masthead says what it was narrowed to, rather than carrying a FILTERED TOTAL
  // with nothing anywhere on the sheet explaining it.
  assert.match(
    scopeLabel(districtReview),
    /own territory/,
    "the workbook masthead names the bound when no filter is set",
  );

  // The unbounded admin read is untouched by all of this.
  const adminReview = reviewFor(null);
  assert.equal(adminReview.scopeIsBounded, false, "the admin screen is not bounded");
  assert.equal(
    reviewTotalRowLabel(adminReview),
    "National total",
    "the admin's unfiltered review still closes with a national total",
  );
  assert.equal(scopeLabel(adminReview), "", "and its masthead still carries no scope at all");

  // ── (4b) A BOUND THAT COVERS THE WHOLE LINE IS NATIONAL ───────────────────────────────────────
  //
  // A National Sales Manager is bound to his line and nothing narrower. On Pedia in September he held
  // all fifty areas and 2,786,792, and his bottom row read "Filtered total" because the test was
  // `viewerScope != null`. What decides it is whether the bound LEAVES SOMETHING OUT, measured
  // against the line as every portal reader receives it (the confidential strip is a lock on everyone).
  const NATIONAL_SCOPE: PerformanceReviewViewerScope = {
    allowedLines: ["CNS"],
    areaCodes: null,
    line: "CNS",
    productCodes: null,
    regionNames: null,
  };
  const nationalReview = reviewFor(NATIONAL_SCOPE);
  assert.equal(
    nationalReview.scopeIsBounded,
    false,
    "a line-wide bound holding every area and every readable product is not a narrowing",
  );
  assert.equal(
    reviewTotalRowLabel(nationalReview),
    "National total",
    "a National Sales Manager's unfiltered bottom row reads National total, not Filtered total",
  );
  // The confidential column is stripped from HIM and from the comparison alike — so it never makes
  // a whole-line bound look narrowed.
  assert.ok(
    !nationalReview.matrixByProduct.columns.some((column) => column.key === "SS001"),
    "and the restricted column is still stripped from him",
  );
  // A genuinely narrowed view still never says National.
  assert.equal(
    reviewScopeIsBounded(matrixFor("2026-09"), { ...NATIONAL_SCOPE, regionNames: new Set(["cairo"]) }),
    true,
    "a regional manager's one region of two is still a narrowing",
  );
  assert.equal(
    reviewScopeIsBounded(matrixFor("2026-09"), { ...NATIONAL_SCOPE, productCodes: new Set(["TB001"]) }),
    true,
    "a product bound that leaves out a readable product is a narrowing even with every area kept",
  );
  assert.equal(
    reviewScopeIsBounded(matrixFor("2026-09"), { ...NATIONAL_SCOPE, areaCodes: new Set(["CA9"]) }),
    true,
    "a bound that matched NOTHING is never called national — zero rows is not the line",
  );
  assert.equal(
    viewerBoundNarrowsTheLine(matrixFor("2026-09"), narrowMatrixToViewerScope(matrixFor("2026-09"), DISTRICT_SCOPE)),
    true,
    "the district manager's two areas of three narrow the line",
  );
  assert.equal(reviewScopeIsBounded(matrixFor("2026-09"), null), false, "no bound at all is the admin read");

  // ── (5) A manager's history starts at JULY, the same floor the admin screen has ───────────────
  //
  // Owner, 2026-10-13: "no show performance review in emp portal starting from july". The portal tab
  // takes the SAME floor as the admin screen, so a bounded reader's series can never reach a month
  // closed on the earlier geography — even when his published list offers one.
  assert.equal(
    PERFORMANCE_REVIEW_FIRST_PERIOD,
    "2026-07",
    "the series starts at July 2026 for every reader, the portal tab included (owner, 2026-10-13)",
  );
  const julToSep = ["2026-07", "2026-08", "2026-09"];
  assert.deepEqual(
    selectSeriesPeriods(julToSep, "2026-09", PERFORMANCE_REVIEW_MONTHS),
    julToSep,
    "every published month from July is a column, oldest first",
  );
  assert.deepEqual(
    selectSeriesPeriods(["2026-01", "2026-06", ...julToSep], "2026-09", PERFORMANCE_REVIEW_MONTHS),
    julToSep,
    "and a month below the floor is dropped outright rather than rendered empty",
  );

  // ── (6) A month he may not read is REFUSED and named, never silently dropped ─────────────────
  const bound = boundPeriodsToPublished(["2026-07", "2026-08", "2026-09"], ["2026-09", "2026-08"]);
  assert.deepEqual(bound.allowed, ["2026-08", "2026-09"], "the published months load");
  assert.deepEqual(
    bound.refused,
    ["2026-07"],
    "an unpublished month comes back named, so the page can say the total covers fewer months",
  );

  // ── (7) The two audiences are disjoint, and a Medical Rep is in neither ──────────────────────
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager"] as PhoenixRole[]) {
    assert.ok(
      canOpenPortalClosingPerformanceReview(access(role)),
      `${role} reads the review in his own portal`,
    );
    assert.ok(
      !canOpenClosingPerformanceReview(access(role)),
      `${role} never reaches the UNBOUNDED company-wide review`,
    );
  }
  assert.ok(
    !canOpenPortalClosingPerformanceReview(access("Medical Rep")),
    "a Medical Rep is refused: the review ranks reps against one another, which his own area bound withholds",
  );
  assert.ok(
    !canOpenPortalClosingPerformanceReview(access("Super Admin")),
    "the admin audience is not a portal viewer — one reader must never have two answers",
  );
  assert.equal(PORTAL_PERFORMANCE_REVIEW_ROLES.size, 3, "three territory tiers, as he named them");

  // ── (8) The tab is actually WIRED — a gate with no row is a grant nobody can reach ───────────
  const HREF = "/employee-portals/monthly-closing/performance-review";
  const wiring: Array<[string, string]> = [
    ["src/components/employee-portal/employee-portal-nav-registry.ts", HREF],
    ["src/components/employee-portal/employee-portal-layout.tsx", HREF],
    ["src/lib/employee-portal/navigation.ts", "showPerformanceReviewTab"],
    ["src/lib/employee-portal/native-module-directory.ts", HREF],
    ["src/config/system-navigation.ts", HREF],
    ["src/lib/navigation/portal-twins.ts", HREF],
  ];
  for (const [file, needle] of wiring) {
    assert.ok(
      readFileSync(file, "utf8").includes(needle),
      `${file} must carry ${needle} — the sidebar row, the flag and the page move together`,
    );
  }

  // ── (9) HIS PICKERS OFFER NOTHING WIDER THAN HIS BOUND, AND A SUBSTITUTED MONTH IS REFUSED ────
  //
  // Two different ways the payload can over-offer, neither of them a leak of figures and both of
  // them a screen that refuses its own options:
  //
  //  • `availableLines` came from `listMonthlyClosingLines()`, which takes no viewer — so a
  //    single-line manager was offered all three lines, and selecting one he does not hold was
  //    refused with "That product line is outside your scope". The refusal is right; the offer was
  //    not. The portal Monthly Closing locks the same field for the same reason.
  //  • `loadMonthlyClosingParts` substitutes the newest VALIDATED month when the requested one is
  //    absent from the closing's global list, which can happen to a published month whose batch was
  //    later invalidated. The multi-month loader guards that; the single-month path — the one a
  //    reader with no month chosen takes — does not, so the loader checks what came back.
  //
  // Pinned at the source because neither can be reached without the closing's own IO.
  const loader = blankOut(readFileSync("src/lib/sales/closing-performance-review-portal.ts", "utf8"));
  assert.ok(
    loader.includes("availableLines: choice.availableLines"),
    "the scoped loader must hand the review HIS line list, or his picker offers lines he cannot open",
  );
  assert.ok(
    loader.includes("review.selectedPeriods") && loader.includes("!periods.includes(period)"),
    "the scoped loader must check the months that came back are the months it asked for — a substituted " +
      "month would be an unpublished one, printed under a heading he did not ask for",
  );
  const reviewLoader = blankOut(readFileSync("src/lib/sales/closing-performance-review.ts", "utf8"));
  assert.ok(
    reviewLoader.includes("input?.availableLines ??"),
    "and the review loader must honour a handed line list, exactly as it honours a handed month list",
  );
}
