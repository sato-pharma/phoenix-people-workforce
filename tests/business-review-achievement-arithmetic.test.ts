import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { emptySlice, totalAreas } from "../src/lib/business-review/canonical.ts";
import type { AreaSummary, Slice } from "../src/lib/business-review/types.ts";

/**
 * Business Review — how a percentage is allowed to be re-aggregated.
 *
 * A percentage cannot be summed. Only the parts it divides can. This module rolls achievement up
 * four times — SKU → family, area → district, line → company, and area → "my districts" in the
 * employee portal — and three of those four were dividing the WRONG numerator until 2026-08-23.
 *
 * The rule, from the sales engine itself (`VsTargetTotals.coveredActualValue`, "the only actual
 * achievement % uses"): the numerator is the actual sitting on a key that HAS a target. Sales on a
 * key nobody set a target for are real money — they belong in the value columns — but they must
 * not lift a percentage against a denominator they were never part of.
 *
 * MEASURED ON PRODUCTION (`ozucdzovmcqvepbozvqf`, 2026-08-23), default Jan–Aug 2026 window:
 *
 *   sales   EGP 76,155,653      <- every actual row, target or no target
 *   covered EGP 29,516,034      <- the actual that sits on a key with a target
 *   target  EGP 58,255,860
 *
 *   sales / target   = 130.73%   <- what the company headline showed
 *   covered / target =  50.67%   <- what it means
 *
 * Eighty points, in the flattering direction, on the first number of a page built to be read in
 * front of a head of department — while every line, area, district and rep BELOW the headline was
 * already dividing correctly, so the top of the page disagreed with everything under it.
 *
 * It reads that badly right now because Mar–Jun 2026 carry ~43.5M EGP of sales and no target row
 * at all. That is also why it survived review: in a window where every product has a target, the
 * two formulas agree exactly, and the bug is invisible.
 *
 * Payouts were never affected — `payoutPercentageFor`/`bandFor` are only ever fed district and
 * area slices, which come from the engine's own `achievementValue` and were always right.
 */

// The production census above, used as a fixture so a regression is reported in the units the
// owner would see rather than as an abstract ratio.
const PROD = { sales: 76_155_653, covered: 29_516_034, target: 58_255_860 };

function sliceFixture(sales: number, covered: number, target: number): Slice {
  return { sales, covered, target, ach: target !== 0 ? Math.round((covered / target) * 100 * 100) / 100 : null };
}

function areaFixture(name: string, sales: number, covered: number, target: number, hasTarget = true): AreaSummary {
  const s = sliceFixture(sales, covered, target);
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
    customersTotal: 0,
    customersByMonth: {},
    outstationClaimed: 0,
    outstationApproved: 0,
    marketingCommitted: 0,
    marketingRequests: 0,
  };
}

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Collapse runs of whitespace so a reformat or a rename of a local does not false-fail this. */
const flat = (s: string) => s.replace(/\s+/g, " ");

export async function runBusinessReviewAchievementArithmeticTests(): Promise<void> {
  // ────────────────────────── 1. the slice carries its own numerator
  //
  // Without this field no caller CAN re-aggregate correctly, which is why all three sites got it
  // wrong: `covered` was computed by the engine, thrown away by `sliceOf`, and then guessed at.
  const empty = emptySlice();
  assert.equal(empty.covered, 0, "an empty slice covers nothing");
  assert.ok("covered" in empty, "Slice must carry the numerator `ach` divides, or nobody can sum it");
  assert.equal(empty.ach, null, "and an empty slice is not gradeable — never 0%");

  // ────────────────────────── 2. totalAreas divides covered, not sales
  //
  // This is the exported helper the employee portal totals a district manager's own areas with,
  // so it is the one re-aggregation reachable from a unit test. Two areas, both with a target,
  // both carrying sales on a product that has none.
  {
    const areas = [
      areaFixture("North", 6_000, 2_000, 4_000),
      areaFixture("South", 4_000, 2_000, 4_000),
    ];
    const t = totalAreas(areas);

    assert.equal(t.sales, 10_000, "the value column still shows every pound that was sold");
    assert.equal(t.covered, 4_000, "but only the covered half is the numerator");
    assert.equal(t.target, 8_000);
    assert.equal(
      t.ach,
      50,
      `sum(covered)/sum(target) = 4,000/8,000 = 50%. Got ${t.ach}%. ` +
        `125% means it divided sum(SALES) by sum(target) — the defect fixed on 2026-08-23.`,
    );
  }

  // A vacant or untargeted area contributes its sales to the value column and nothing to the
  // percentage. This is the shape that made Mar–Jun 2026 so destructive.
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
        `500% means nine thousand pounds nobody asked for were credited against somebody else's target.`,
    );
  }

  // No target at all is NOT zero achievement. A 0% here would put every rep in a target-less
  // month on a failure list.
  {
    const t = totalAreas([areaFixture("Ungraded", 5_000, 0, 0, false)]);
    assert.equal(t.ach, null, "no target to divide by means not gradeable, never 0%");
    assert.equal(t.sales, 5_000, "and the sales are still reported");
  }

  assert.equal(totalAreas([]).ach, null, "an empty scope grades nothing");

  // ────────────────────────── 3. the production case, as arithmetic
  //
  // Pins the two numbers in the header comment so a regression names itself.
  {
    const right = Math.round((PROD.covered / PROD.target) * 100 * 100) / 100;
    const wrong = Math.round((PROD.sales / PROD.target) * 100 * 100) / 100;
    assert.equal(right, 50.67, "the honest grade for Jan–Aug 2026");
    assert.equal(wrong, 130.73, "and what dividing the full sales figure produced");
    assert.ok(wrong - right > 80, "the gap is eighty points, not a rounding difference");

    // The same fixture through the real helper, to prove the helper produces the honest one.
    const t = totalAreas([areaFixture("Company", PROD.sales, PROD.covered, PROD.target)]);
    assert.equal(t.ach, right, "totalAreas reproduces the production figure the page now shows");
  }

  // ────────────────────────── 4. the three unreachable rollups, guarded at the source
  //
  // `buildCompany`, `familyRowsOf` and the portal's `totals` memo are all module-private and two
  // of them are inside client components, so no unit test can call them. What CAN be checked is
  // that none of them divides a sales figure. These are whitespace-insensitive substring checks
  // over the whole file — never a byte window, which false-fails the moment a function grows.
  {
    const canonical = flat(SRC("src/lib/business-review/canonical.ts"));

    assert.ok(
      canonical.includes("const slice = (c: number, s: number, t: number): Slice => ({"),
      "the company rollup must take the covered figure as its own argument, not derive it",
    );
    assert.ok(
      canonical.includes("ach: t !== 0 ? round2((c / t) * 100) : null"),
      "the company headline must divide covered by target",
    );
    assert.ok(
      !canonical.includes("ach: t !== 0 ? round2((s / t) * 100) : null"),
      "and must never divide the full sales figure by the covered target — that is the 130.73% bug",
    );
    assert.ok(
      canonical.includes("covered: round2(t.coveredActualValue)"),
      "`sliceOf` must carry the engine's own covered figure through to every consumer",
    );
    assert.ok(
      canonical.includes("total.coveredActualValue += area.allProducts.covered"),
      "`totalAreas` must use the key-grain covered figure, not an area-grain `hasTarget` proxy",
    );

    const portal = flat(SRC("src/components/business-review/portal-review.client.tsx"));
    assert.ok(
      portal.includes("const covered = areas.reduce((sum, a) => sum + a.allProducts.covered, 0)"),
      "the portal must total the covered figure across the areas a manager was granted",
    );
    assert.ok(
      portal.includes("ach: target > 0 ? (100 * covered) / target : null"),
      "and divide it — a district manager's own headline had the same defect as the company one",
    );

    const dashboard = flat(SRC("src/components/business-review/dashboard.client.tsx"));
    assert.ok(
      dashboard.includes("const ach = (covered: number, target: number) => (target > 0 ? (100 * covered) / target : null)"),
      "the product-family mix must divide covered by target, not sales by target",
    );
    assert.ok(
      dashboard.includes("total: ach(f.totalCovered, f.totalTarget)"),
      "including the family's own total column",
    );

    // The export describes its own arithmetic on the cover sheet. A caption that says
    // "sum(sales) / sum(target)" beside a covered-based percentage is a subtler lie than the
    // wrong number was, because it reads as though somebody checked.
    const xlsx = flat(SRC("src/lib/business-review/excel-export.ts"));
    assert.ok(
      !xlsx.includes('"sum(sales) / sum(target)'),
      "the workbook must not describe the achievement as sum(sales)/sum(target) — it is not",
    );
    assert.ok(
      xlsx.includes("sum(covered sales) / sum(target)"),
      "it must say which numerator it divides, twice: company cover sheet and per-line sheet",
    );
  }
}
