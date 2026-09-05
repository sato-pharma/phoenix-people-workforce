import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import JSZip from "jszip";

import { buildClosingEngineFill } from "../src/lib/sales/closing-engine-data.ts";
import { buildClosingPerformanceReview, type AreaSeatAssignment } from "../src/lib/sales/closing-performance-review.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE PREMIUM WORKBOOK'S ACHIEVEMENT IS THE MONTHLY CLOSING'S ACHIEVEMENT.
//
// Owner's ruling, 2026-09-05, on being shown both numbers for August's Anti Infective:
// "THE OLD CLOSING IS THE CORRECT ONE." So achievement is ALL of a row's sales over the target it
// was given — `closingAchievement` in monthly-closing-matrix-cells.ts — everywhere in the premium
// export, exactly as the closing screen and the auditor's workbook already print it.
//
// WHAT THIS TEST EXISTS TO CATCH, and why nothing else can catch it.
//
// The engine used to divide only the sales sitting on a product that HAD a target. The two rules
// are ARITHMETICALLY IDENTICAL unless a single area sells both a targeted product and an untargeted
// one — and `tests/closing-engine-export.test.ts`'s fixture has no such area (Cairo 1 and Qalubeya
// are targeted throughout, Cairo 2 has no target at all), so the whole suite stayed green across
// the change in both directions. Live, that shape is the norm rather than the exception: August's
// Anti Infective carried 27,529.80 EGP of it over 24 area x product pairs and the two files read
// 29.95% and 31.78%. Hence the MIXED area below — it is the entire point of this fixture.
//
// The rule is also carried in FOUR formulas inside the owner's own .xlsm, which no TypeScript
// assertion can see: the two pivot calculated fields and the Rep Card's two divisions. Those are
// pinned against the shipped template at the bottom, because `scripts/build-closing-engine-template.mjs`
// regenerates that file from whatever source workbook it is handed — so a rebuild from the owner's
// pre-2026-09-05 copy would silently restore the old rule in the workbook while every TypeScript
// test here still passed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PRODUCTS = [
  { family: "Royafloxacin", productCode: "RO001", productName: "Royafloxacin" },
  { family: "Saginko", productCode: "SA001", productName: "Saginko" },
];

/** A matrix cell, with the closing's OWN achievement on it: all sales over target. */
function cell(
  salesUnits: number,
  salesValue: number,
  targetUnits: number | null,
  targetValue: number | null,
): MonthlyClosingCell {
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits,
    targetValue,
  };
}

function sum(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const salesUnits = cells.reduce((total, one) => total + one.salesUnits, 0);
  const salesValue = cells.reduce((total, one) => total + one.salesValue, 0);
  const targeted = cells.filter((one) => one.targetValue != null);
  const targetValue = targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetValue ?? 0), 0);
  const targetUnits = targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetUnits ?? 0), 0);
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits,
    targetValue,
  };
}

function area(
  areaCode: string,
  areaName: string,
  regionCode: string,
  regionName: string,
  cells: MonthlyClosingCell[],
): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells, kind: "area", regionCode, regionName, rowTotal: sum(cells) };
}

/**
 * The shape the old fixture could not express, in the smallest form that still separates the rules.
 *
 * Cairo 1 is the MIXED area: Royafloxacin is targeted, Saginko sells 40,000 EGP against no target at
 * all. Every number is chosen so the two readings are far apart and neither is a round coincidence:
 *
 *   all sales / target  = 140,000 / 100,000 = 140%   <- the closing, and what must be printed
 *   targeted only       = 100,000 / 100,000 = 100%   <- the rule this test exists to keep out
 *
 * Delta 11 is fully targeted, so it reads the same under either rule and proves the change did not
 * simply move every number. Cairo 2 sells with no target anywhere and must stay unranked — the one
 * behaviour that is deliberately UNCHANGED, since only the numerator moved.
 */
function fixtureMatrix(period: string, scale = 1): MonthlyClosingMatrix {
  const cairo1 = area("CA1", "Cairo 1", "CA", "Cairo", [
    cell(500 * scale, 100_000 * scale, 400, 100_000),
    cell(200 * scale, 40_000 * scale, null, null),
  ]);
  const cairo2 = area("CA2", "Cairo 2", "CA", "Cairo", [
    cell(30 * scale, 9_000 * scale, null, null),
    cell(10 * scale, 3_000 * scale, null, null),
  ]);
  const delta11 = area("D11", "Qalubeya", "D1", "Delta (1)", [
    cell(300 * scale, 60_000 * scale, 250, 50_000),
    cell(100 * scale, 25_000 * scale, 120, 30_000),
  ]);

  const regions = [
    { areas: [cairo1, cairo2], regionCode: "CA", regionName: "Cairo" },
    { areas: [delta11], regionCode: "D1", regionName: "Delta (1)" },
  ].map((group) => ({
    ...group,
    subtotal: {
      cells: PRODUCTS.map((_, index) => sum(group.areas.map((one) => one.cells[index]!))),
      kind: "regionSubtotal" as const,
      regionCode: group.regionCode,
      regionName: group.regionName,
      rowTotal: sum(group.areas.map((one) => one.rowTotal)),
    },
  }));

  const allAreas = regions.flatMap((group) => group.areas);
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-07", "2026-08"],
    columns: PRODUCTS,
    grandTotal: {
      cells: PRODUCTS.map((_, index) => sum(allAreas.map((one) => one.cells[index]!))),
      kind: "grandTotal",
      rowTotal: sum(allAreas.map((one) => one.rowTotal)),
    },
    line: "Anti Infective",
    period,
    regions,
  };
}

const SEATS = new Map<string, AreaSeatAssignment>([
  ["anti infective::CA1", { managerName: "Hala Fouad", repIsVacant: false, repName: "Mostafa Kamel" }],
  ["anti infective::CA2", { managerName: "Hala Fouad", repIsVacant: true, repName: null }],
  ["anti infective::D11", { managerName: "Tarek Selim", repIsVacant: false, repName: "Nour Adel" }],
]);

const near = (actual: unknown, expected: number, what: string) => {
  assert.equal(typeof actual, "number", `${what} must be a number, got ${JSON.stringify(actual)}`);
  assert.ok(
    Math.abs((actual as number) - expected) < 1e-9,
    `${what}: expected ${expected}, got ${String(actual)}`,
  );
};

export async function runClosingAchievementFollowsTheClosingTests() {
  const august = fixtureMatrix("2026-08");
  const july = fixtureMatrix("2026-07", 0.5);
  const review = buildClosingPerformanceReview({
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-07", "2026-08"],
    generatedAt: "2026-09-05T12:00:00.000Z",
    matrix: august,
    seatAssignments: SEATS,
    seriesMatrices: [
      { matrix: july, period: "2026-07" },
      { matrix: august, period: "2026-08" },
    ],
  });

  const fill = buildClosingEngineFill({ matrix: august, priorMatrix: july, review });

  // ── The mixed area reads the CLOSING's number ───────────────────────────────────────────────
  // This single assertion is the headline of the file: 140%, not 100%. It is what the owner ruled
  // on, and the one that fires if anyone reinstates the targeted-only numerator.
  const ranking = fill.sheets["Rep Ranking"]?.rows ?? [];
  const mixed = ranking.find((row) => row[2] === "Cairo 1");
  assert.ok(mixed, "Cairo 1 is on the Rep Ranking sheet");
  near(mixed![7], 1.4, "Cairo 1's achievement is ALL its sales over its target (140%), not the targeted half (100%)");

  // And it is the SAME number the Closing Matrix prints for that row, which is the actual rule
  // rather than a restatement of the arithmetic above: the two files may not diverge again.
  const cairo1Row = august.regions[0]!.areas[0]!;
  near(mixed![7], cairo1Row.rowTotal.achievement!, "the workbook's area achievement IS the closing matrix's own");

  // A fully targeted area is unmoved — proof the change is confined to untargeted money.
  const fully = ranking.find((row) => row[2] === "Qalubeya");
  near(fully![7], 85_000 / 80_000, "a fully targeted area reads the same under either rule");

  // ── An untargeted area is still never scored ───────────────────────────────────────────────
  // Only the numerator moved. A missing target still yields NO percentage — never 0%, which would
  // accuse a rep of failing at something nobody asked of them.
  const untargeted = ranking.find((row) => row[2] === "Cairo 2");
  assert.equal(untargeted![7], "no target", "an area with no target is still unscored, not 0%");

  // ── The masthead divides ───────────────────────────────────────────────────────────────────
  // B5 / D5 = F5, so a reader can check the headline by hand. It did not divide before: F5 showed
  // targeted sales over target while B5 showed every pound.
  const overview = fill.sheets.Overview?.cells ?? {};
  const sales = overview.B5 as number;
  const target = overview.D5 as number;
  near(sales, 237_000, "B5 is every pound the line sold");
  near(target, 180_000, "D5 is every target set on it");
  near(overview.F5, sales / target, "F5 is B5 over D5 — the masthead's three numbers tie");

  // ── Overview region rows divide the same way ───────────────────────────────────────────────
  for (const row of fill.sheets.Overview?.rows ?? []) {
    const [name, , regionSales, regionTarget, achievement] = row;
    if (typeof achievement !== "number" || typeof regionTarget !== "number" || regionTarget === 0) continue;
    near(achievement, (regionSales as number) / regionTarget, `Overview row ${String(name)} must divide its own two columns`);
  }

  // ── Family Performance agrees with the screen it is a copy of ──────────────────────────────
  // The Performance Review's own family table is what the closing screen shows; the workbook prints
  // it unaltered. Between 2026-09-03 and 2026-09-05 this sheet recomputed it from targeted-only
  // sales and disagreed with the screen by exactly the untargeted money.
  for (const row of fill.sheets["Family Performance"]?.rows ?? []) {
    const family = review.families.find((one) => one.family === row[0]);
    assert.ok(family, `Family Performance row ${String(row[0])} matches a review family`);
    assert.deepEqual(
      row[4],
      family!.achievement ?? "no target",
      `${String(row[0])}: the workbook prints the review's own achievement, never its own recomputation`,
    );
  }
  // Saginko is the family-level version of the mixed area, and it separates the two rules by the
  // widest margin in this fixture: it sells 68,000 across three areas but is targeted in Delta
  // alone, for 30,000. All sales over target is 226.7%; the targeted-only numerator would count
  // Delta's 25,000 and print 83.3% — a family shown as missing its target while beating it more
  // than twofold. Asserted as a figure, not as "matches review", so the rule is legible here.
  const saginko = (fill.sheets["Family Performance"]?.rows ?? []).find((row) => row[0] === "Saginko");
  near(saginko![4], 68_000 / 30_000, "Saginko divides ALL 68,000 of its sales by its 30,000 target (226.7%), never Delta's 25,000 alone (83.3%)");

  // ── The owner's .xlsm carries the same rule, in its own four formulas ──────────────────────
  // Read from the SHIPPED artifact, not from any source that describes it. A regeneration of the
  // template from a pre-2026-09-05 workbook is the one way this rule comes back wrong while every
  // assertion above still passes.
  // Resolved against this file, never the working directory: the suite is started from the repo
  // root today, and a runner that ever starts anywhere else would turn this into a missing-file
  // crash rather than the assertion it is.
  const templatePath = new URL("../assets/closing-engine/template.xlsm", import.meta.url);
  const templateZip = await JSZip.loadAsync(readFileSync(templatePath));
  const pivotCache = await templateZip.file(/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/)[0]!.async("string");

  for (const [field, expected] of [
    ["Ach", "IF('Target Value'&gt;0,'Sales Value'/'Target Value',-1)"],
    ["Units Ach", "IF('Target Units'&gt;0,'Units'/'Target Units',-1)"],
  ] as const) {
    const formula = new RegExp(`<cacheField name="${field}"[^>]*formula="([^"]*)"`).exec(pivotCache)?.[1];
    assert.equal(formula, expected, `the pivots' ${field} field divides the plain column, never the "Targeted" one`);
  }

  const repCard = await templateZip.file("xl/worksheets/sheet3.xml")!.async("string");
  const formulas = [...repCard.matchAll(/<f[^>]*>([\s\S]*?)<\/f>/g)].map((one) => one[1]!);
  assert.ok(
    formulas.some((one) => one.includes("INDEX(AreaBook[Sales Value],$N$1)/INDEX(AreaBook[Target Value],$N$1)")),
    "the Rep Card's headline achievement divides the area's whole sales by its target",
  );
  assert.ok(
    formulas.some((one) => one === 'IF(F17&gt;0,E17/F17,"no target")'),
    "the Rep Card's product row divides the two columns printed beside it (E/F), not the hidden targeted helper",
  );
  assert.deepEqual(
    formulas.filter((one) => one.includes("Targeted") && one.includes("/")),
    [],
    "no formula in the engine divides a Targeted column any more — that is the rule the owner overturned",
  );
}
