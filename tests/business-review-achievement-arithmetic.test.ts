import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { emptySlice, totalAreas } from "../src/lib/business-review/canonical.ts";
import type { AreaSummary, Slice } from "../src/lib/business-review/types.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { gradedPeriodsOf, totalRows } from "../src/lib/sales/vs-target.ts";

/**
 * Business Review — how a percentage is allowed to be re-aggregated, and WHICH numerator it uses.
 *
 * TWO SEPARATE RULES LIVE HERE. The first has never changed; the second was reversed by the owner
 * on 2026-09-05 and is the reason this file was rewritten.
 *
 * RULE 1 — a percentage cannot be summed, only the parts it divides can. This module rolls
 * achievement up four times (SKU → family, area → district, line → company, and area → "my
 * districts" in the portal) and three of the four were dividing a number they had not carried,
 * until 2026-08-23. Every assertion about `sum(graded)/sum(target)` below is that rule, and it is
 * untouched.
 *
 * RULE 2 — what `graded` MEANS. Owner ruling 2026-09-05, "FOLLOW THE OLD MONTHLY CLOSING ... MUST
 * BE 100% IDENTICAL": this page must print the number the Monthly Closing prints. The closing
 * carries two halves and both are in force:
 *
 *   inside a month, EVERY pound counts — including sales on a product nobody targeted;
 *   across months, a month carrying NO target at all is left out of the numerator entirely.
 *
 * The second half is not an invention: it is the old export's own "ALL MONTHS" row
 * (monthly-closing-export.ts, Block 5), whose formula is `SUMIF(target,">0",sales)/SUM(target)`
 * and whose comment gives the reason — dividing every month's sales by the targeted months'
 * targets "would print a wildly flattering percentage against a target nobody set for those
 * months". Business Review needs that half because it spans a WINDOW; the closing does not,
 * because it covers one month.
 *
 * MEASURED ON PRODUCTION (`ozucdzovmcqvepbozvqf`, 2026-09-05), Jan–Sep, the three tracked lines:
 *
 *   sales   EGP 73.71M      target EGP 95.05M
 *
 *   all sales / target              = 77.55%   <- ignoring rule 2's second half
 *   sales in targeted months / t    = 35.26%   <- the closing's own rule, what this page shows
 *   covered actual / target         = 32.51%   <- the retired rule, kept here as the near-miss
 *
 * The first and last differ by forty-five points, and the middle one is what the owner chose. Note
 * how close 35.26% and 32.51% are: a test fixture that does not deliberately separate them will
 * pass under either rule, which is exactly how the wrong one could return unnoticed.
 *
 * Mar–Jun 2026 carry sales and no target row at all, which is what makes the first reading absurd.
 * `gradedRowsOf` is a SEPARATE and complementary filter — it drops months whose distributor files
 * have not landed yet — and the two stack rather than overlap.
 *
 * Payouts were never affected by any of this: `payoutPercentageFor`/`bandFor` are only ever fed
 * district and area slices, which come from the engine's own `achievementValue`.
 */

// Measured 2026-09-05, used as a fixture so a regression names itself in the units the owner reads.
const PROD = { sales: 73_710_000, graded: 33_520_000, covered: 30_900_000, target: 95_050_000 };

function sliceFixture(sales: number, graded: number, target: number): Slice {
  return { sales, graded, target, ach: target !== 0 ? Math.round((graded / target) * 100 * 100) / 100 : null };
}

function areaFixture(name: string, sales: number, graded: number, target: number, hasTarget = true): AreaSummary {
  const s = sliceFixture(sales, graded, target);
  return {
    area: name,
    areaCode: name,
    dmSeatId: "SEAT-1",
    dm: "A District Manager",
    region: "Cairo",
    vacant: false,
    includeOnly: s,
    allProducts: s,
    hasTarget,
    ungradeable: false,
    hasReturns: false,
    products: {},
    trend: [],
    byMonth: {},
    reps: 1,
    visits: 0,
    regularVisits: 0,
    campaignVisits: 0,
    visitsByMonth: {},
    doubleVisits: 0,
    // The three-way split (owner's AM · PM · Pharmacies rule) is zero here on purpose: this file
    // tests the graded-month ARITHMETIC, and a visit count never enters it.
    visitSplit: { am: 0, pm: 0, pharmacies: 0 },
    customersTotal: 0,
    customersAm: 0,
    customersPm: 0,
    customersPharmacy: 0,
    customersByMonth: {},
    outstationClaimed: 0,
    outstationApproved: 0,
    marketingCommitted: 0,
    marketingRequests: 0,
  };
}

/** A canonical row, with only the fields the graded-month arithmetic reads set meaningfully. */
function achRow(period: string, areaCode: string, actualValue: number, targetValue = 0): AchievementRow {
  return {
    period,
    lineCode: "pedia",
    regionCode: "CA",
    areaCode,
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: "R-1",
    dmSeatId: "SEAT-1",
    dmHrId: "D-1",
    productCode: "GU001",
    actualUnits: 0,
    actualValue,
    targetUnits: null,
    targetValue: targetValue > 0 ? targetValue : null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: targetValue > 0,
    hasActual: true,
  };
}

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Collapse runs of whitespace so a reformat or a rename of a local does not false-fail this. */
const flat = (s: string) => s.replace(/\s+/g, " ");

export async function runBusinessReviewAchievementArithmeticTests(): Promise<void> {
  // ────────────────────────── 1. the slice carries its own numerator
  //
  // Without this field no caller CAN re-aggregate correctly, which is why three sites got it
  // wrong: the numerator was computed by the engine, thrown away by `sliceOf`, then guessed at.
  const empty = emptySlice();
  assert.equal(empty.graded, 0, "an empty slice grades nothing");
  assert.ok("graded" in empty, "Slice must carry the numerator `ach` divides, or nobody can sum it");
  assert.ok(!("covered" in empty), "the retired numerator must not linger under its old name beside the new one");
  assert.equal(empty.ach, null, "and an empty slice is not gradeable — never 0%");

  // ────────────────────────── 2. totalAreas divides the graded figure, not sales
  //
  // The exported helper the employee portal totals a district manager's own areas with, and the
  // one re-aggregation reachable from a unit test.
  {
    const areas = [
      areaFixture("North", 6_000, 2_000, 4_000),
      areaFixture("South", 4_000, 2_000, 4_000),
    ];
    const t = totalAreas(areas);

    assert.equal(t.sales, 10_000, "the value column still shows every pound that was sold");
    assert.equal(t.graded, 4_000, "and the numerator is the graded figure the slices carried");
    assert.equal(t.target, 8_000);
    assert.equal(
      t.ach,
      50,
      `sum(graded)/sum(target) = 4,000/8,000 = 50%. Got ${t.ach}%. ` +
        `125% means it divided sum(SALES) by sum(target), which is re-aggregating a percentage ` +
        `from a numerator it never carried — a different defect from which numerator is correct.`,
    );
  }

  // An area whose whole window is untargeted contributes sales and no numerator. Under the owner's
  // rule this is the ACROSS-MONTHS half doing its job: nothing about that area was ever targeted,
  // so none of its money is graded against somebody else's target.
  {
    const areas = [
      areaFixture("Graded", 1_000, 1_000, 2_000),
      areaFixture("No target anywhere", 9_000, 0, 0, false),
    ];
    const t = totalAreas(areas);
    assert.equal(t.sales, 10_000, "the untargeted area's sales are real money and stay visible");
    assert.equal(
      t.ach,
      50,
      `one graded area at 1,000/2,000 is 50%, whatever the untargeted area sold. Got ${t.ach}%. ` +
        `500% means nine thousand pounds from a window nobody targeted were credited against ` +
        `somebody else's target — the reading the closing's own ALL MONTHS row refuses.`,
    );
  }

  // No target at all is NOT zero achievement. Only the numerator moved on 2026-09-05; this is
  // untouched, and a 0% here would put every rep in a target-less month on a failure list.
  {
    const t = totalAreas([areaFixture("Ungraded", 5_000, 0, 0, false)]);
    assert.equal(t.ach, null, "no target to divide by means not gradeable, never 0%");
    assert.equal(t.sales, 5_000, "and the sales are still reported");
  }

  assert.equal(totalAreas([]).ach, null, "an empty scope grades nothing");

  // ────────────────────────── 3. the production window, as arithmetic
  //
  // Pins the three readings in the header so a regression names itself. The one in the middle is
  // the owner's, and the assertion that matters is that it is NOT the naive one.
  {
    const chosen = Math.round((PROD.graded / PROD.target) * 100 * 100) / 100;
    const naive = Math.round((PROD.sales / PROD.target) * 100 * 100) / 100;
    const retired = Math.round((PROD.covered / PROD.target) * 100 * 100) / 100;
    assert.equal(chosen, 35.27, "the closing's own rule over Jan–Sep 2026");
    assert.equal(naive, 77.55, "and what ignoring the across-months half produces");
    assert.ok(naive - chosen > 40, "the gap is forty-plus points, not a rounding difference");
    assert.ok(
      Math.abs(chosen - retired) < 3,
      "the chosen and retired rules land within three points of each other on this window, which is " +
        "precisely why a fixture must separate them deliberately rather than rely on production shape",
    );

    // The same window through the real helper, to prove the helper produces the chosen one.
    const t = totalAreas([areaFixture("Company", PROD.sales, PROD.graded, PROD.target)]);
    assert.equal(t.ach, chosen, "totalAreas reproduces the figure the page shows");
  }

  // ────────────────────────── 4. the three unreachable rollups, guarded at the source
  //
  // `buildCompany`, `familyRowsOf` and the portal's `totals` memo are all module-private and two
  // of them are inside client components, so no unit test can call them. What CAN be checked is
  // that each divides the carried numerator. Whitespace-insensitive substring checks over the
  // whole file — never a byte window, which false-fails the moment a function grows.
  {
    const canonical = flat(SRC("src/lib/business-review/canonical.ts"));

    assert.ok(
      canonical.includes("const slice = (c: number, s: number, t: number): Slice => ({"),
      "the company rollup must take the numerator as its own argument, not derive it",
    );
    assert.ok(
      canonical.includes("ach: t !== 0 ? round2((c / t) * 100) : null"),
      "the company headline must divide the carried numerator by target",
    );
    assert.ok(
      !canonical.includes("ach: t !== 0 ? round2((s / t) * 100) : null"),
      "and must never divide the full sales figure by the target — that is the 77.55% reading",
    );
    assert.ok(
      canonical.includes("graded: round2(t.gradedActualValue)"),
      "`sliceOf` must carry the ENGINE's graded figure — the one that honours both halves of the closing's rule",
    );
    assert.ok(
      !canonical.includes("covered: round2(t.coveredActualValue)"),
      "and must not go back to the covered-actual numerator the owner ruled against on 2026-09-05",
    );
    assert.ok(
      canonical.includes("total.gradedActualValue += area.allProducts.graded"),
      "`totalAreas` must use the key-grain graded figure, not an area-grain `hasTarget` proxy",
    );

    const portal = flat(SRC("src/components/business-review/portal-review.client.tsx"));
    assert.ok(
      portal.includes("const graded = areas.reduce((sum, a) => sum + a.allProducts.graded, 0)"),
      "the portal must total the graded figure across the areas a manager was granted",
    );
    assert.ok(
      portal.includes("ach: target > 0 ? (100 * graded) / target : null"),
      "and divide it — a district manager's own headline had the same defect as the company one",
    );

    const dashboard = flat(SRC("src/components/business-review/dashboard.client.tsx"));
    assert.ok(
      dashboard.includes("f.totalCovered += p.total.graded;"),
      "the product-family mix must accumulate the graded figure from each SKU's slice",
    );
    assert.ok(
      dashboard.includes("total: ach(f.totalCovered, f.totalTarget)"),
      "including the family's own total column",
    );

    // The export describes its own arithmetic on the cover sheet. A caption naming a numerator the
    // sheet does not divide is a subtler lie than a wrong number, because it reads as though
    // somebody checked.
    const xlsx = flat(SRC("src/lib/business-review/excel-export.ts"));
    assert.ok(
      !xlsx.includes('"sum(sales) / sum(target)'),
      "the workbook must not describe the achievement as sum(sales)/sum(target) — it is not",
    );
    assert.ok(
      xlsx.includes("sum(graded sales) / sum(target)"),
      "it must say which numerator it divides, twice: company cover sheet and per-line sheet",
    );
    assert.ok(
      !xlsx.includes("sum(covered sales) / sum(target)"),
      "and must not still name the retired numerator",
    );
  }

  // ────────────────────────── 5. WHOSE target decides a graded month — the LINE's
  //
  // Owner ruling 2026-09-26. Rule 2 above says a month carrying no target is left out of the
  // numerator; it does not, on its own, say whose target. Every grain used to answer that about
  // ITSELF, and the grains then stopped adding up: an area untargeted in a month its LINE was
  // targeted in dropped that month's sales from its own numerator while the line kept them.
  //
  // Measured on production (`ozucdzovmcqvepbozvqf`) for Jul–Aug 2026, the three tracked lines:
  //
  //   line-level rule    28,099,685 / 37,791,711 = 74.35%   <- the admin page, and the closing
  //   area-level rule    26,501,019 / 37,791,711 = 70.12%   <- the portal, which sums areas
  //
  // 1,598,667 EGP of sales, 4.2 points, and two screens of one module disagreeing about the same
  // window. Momen Abdelhady Mohamed Shehata's own page read 24.1% against the 31.3% in the DSM
  // league table his review was run from.
  //
  // The fixture below separates the two rules deliberately, for the reason the header already
  // gives: on most real shapes they land close enough that a careless fixture passes under either.
  {
    const lineRows = [
      achRow("2026-07", "A", 1_000, 2_000),
      achRow("2026-08", "A", 1_000, 2_000),
      achRow("2026-07", "B", 500, 1_000),
      // August: area B sold and carries no target of its own. Its LINE was targeted that month.
      achRow("2026-08", "B", 500),
    ];
    const aRows = lineRows.filter((r) => r.areaCode === "A");
    const bRows = lineRows.filter((r) => r.areaCode === "B");

    const line = totalRows(lineRows);
    assert.equal(line.gradedActualValue, 3_000, "the line was targeted in both months, so both months' sales are graded");
    assert.equal(line.targetValue, 5_000);
    assert.equal(line.achievementValue, 0.6, "the line reads 60%");

    // The default — every group answers for itself — is what every OTHER sales surface uses, and
    // must not change. Sales vs Target, rep targets and the portal SoS team view all rely on it.
    const bAlone = totalRows(bRows);
    assert.equal(
      bAlone.gradedActualValue,
      500,
      "asked about itself, area B grades only July — the standing per-group rule, unchanged for every caller that passes no override",
    );

    // The override: the line's months, handed down.
    const graded = gradedPeriodsOf(lineRows);
    assert.deepEqual([...graded].sort(), ["2026-07", "2026-08"], "the line's own targeted months");
    const bUnderLine = totalRows(bRows, graded);
    assert.equal(
      bUnderLine.gradedActualValue,
      1_000,
      "under the line's rule area B's August sales are graded too — its line WAS targeted that month",
    );

    const sumOld = totalRows(aRows).gradedActualValue + bAlone.gradedActualValue;
    const sumNew = totalRows(aRows, graded).gradedActualValue + bUnderLine.gradedActualValue;
    assert.equal(sumOld, 2_500, "the area-level rule loses August's 500 from the numerator");
    assert.equal(
      sumNew,
      line.gradedActualValue,
      `summing the areas must reproduce the line exactly. Got ${sumNew} against the line's ${line.gradedActualValue}. ` +
        `A shortfall is the defect that made the portal read 70.12% where the admin page read 74.35%.`,
    );
    // `assert.notEqual`, not `assert.ok(sumOld !== sumNew)`: the two `assert.equal`s above narrow
    // both locals to literal types, and TypeScript then rejects `!==` between two disjoint literals
    // as TS2367 — which `pnpm run test` cannot see, because it strips types.
    assert.notEqual(sumOld, sumNew, "the fixture must separate the two rules, or it passes under either");

    // And through the helper the portal's own memo mirrors, on slices shaped as the builders emit
    // them: the scoped total a district manager sees equals the figure their line was graded on.
    const scoped = totalAreas([
      areaFixture("A", 2_000, totalRows(aRows, graded).gradedActualValue, 4_000),
      areaFixture("B", 1_000, bUnderLine.gradedActualValue, 1_000),
    ]);
    assert.equal(scoped.graded, 3_000, "the scoped numerator is the line's");
    assert.equal(scoped.ach, 60, `and the scoped percentage equals the line's 60%. Got ${scoped.ach}%.`);
  }

  // ────────────────────────── 6. the one set is built once per line, and reaches every grain
  //
  // The arithmetic above cannot see whether canonical.ts actually PASSES the set down — the
  // builders are module-private and need a database. These pins are the other half: a refactor
  // that drops the second argument anywhere puts that grain back on its own rule silently, and
  // the only symptom is two screens quietly disagreeing again.
  {
    const canonical = flat(SRC("src/lib/business-review/canonical.ts"));

    assert.ok(
      canonical.includes("gradedPeriods: gradedPeriodsOf(lineRows)"),
      "the graded months must be decided ONCE per line, from that line's own rows",
    );
    assert.ok(
      canonical.includes("gradedPeriods: ReadonlySet<string>"),
      "and travel on the build context, so every grain beneath the line reads the same set",
    );
    for (const call of [
      "sliceOf(totalRows(areaRows, graded))",
      "sliceOf(totalRows(seatRows, graded))",
      "sliceOf(totalRows(includeRows, graded))",
      "sliceOf(totalRows(activeRows, graded))",
      "sliceOf(totalRows(exVacantRows, graded))",
      "sliceOf(totalRows(productRows, ctx.gradedPeriods))",
    ]) {
      assert.ok(canonical.includes(call), `every grain must grade on the line's months — \`${call}\` is missing`);
    }
    for (const bare of [
      "sliceOf(totalRows(areaRows))",
      "sliceOf(totalRows(seatRows))",
      "sliceOf(totalRows(includeRows))",
      "sliceOf(totalRows(activeRows))",
      "sliceOf(totalRows(exVacantRows))",
      "sliceOf(totalRows(productRows))",
    ]) {
      assert.ok(
        !canonical.includes(bare),
        `\`${bare}\` grades that grain on its OWN months again — the 70.12%-vs-74.35% defect, back`,
      );
    }
    assert.ok(
      canonical.includes("monthlySlices(areaRows, periods, graded)"),
      "the per-month slices must use it too, or a month's numerator disagrees with the window's",
    );

    // The shared helper keeps its own default for everybody else. An override that became
    // mandatory would silently regrade Sales vs Target, rep targets and the portal SoS view.
    const vsTarget = flat(SRC("src/lib/sales/vs-target.ts"));
    assert.ok(
      vsTarget.includes("export function totalRows(rows: AchievementRow[], gradedPeriods?: ReadonlySet<string>)"),
      "the override must stay OPTIONAL — every caller outside the Business Review grades per group",
    );
    assert.ok(
      vsTarget.includes("const graded = gradedPeriods ?? gradedPeriodsOf(rows)"),
      "and fall back to the group's own months when none is given",
    );
  }
}
