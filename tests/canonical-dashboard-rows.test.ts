import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { aggregateCanonicalDashboardRows } from "../src/lib/sales/dashboard-canonical.ts";
import { getMergedAreaName } from "../src/lib/sales/closing-area-merges.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

// Spread-merged, NOT `??`-defaulted: `repHrId: null` is the exact case this fixture exists to
// express (a vacant seat), and `??` would silently substitute the default for it.
function row(overrides: Partial<AchievementRow> & { period: string }): AchievementRow {
  const merged: AchievementRow = {
    lineCode: "cns",
    regionCode: "AB",
    areaCode: "D16",
    areaState: "occupied",
    isOther: false,
    repSeatId: "SEAT-CNS-REP-D16",
    repHrId: "b-158",
    dmSeatId: "SEAT-CNS-DM-AB",
    dmHrId: "b-119",
    productCode: "TE003",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...overrides,
  };
  return {
    ...merged,
    hasTarget: "hasTarget" in overrides ? merged.hasTarget : merged.targetValue != null,
    hasActual: "hasActual" in overrides ? merged.hasActual : merged.actualValue !== 0,
  };
}

export function runCanonicalDashboardRowsTests() {
  const july = new Set(["2026-07"]);

  // ── A vacant area's sales still belong to the company ──────────────────────
  // The portal drops these on purpose (nobody earned them, so nobody is credited). The ADMIN
  // total is the company's total: dropping them would under-report the company by exactly the
  // sales nobody was hired to make, and it would do it silently.
  const vacant = aggregateCanonicalDashboardRows(
    [
      row({ period: "2026-07", actualValue: 400_000, actualUnits: 40, targetValue: 300_000 }),
      row({ period: "2026-07", areaCode: "D17", repHrId: null, repSeatId: null, actualValue: 90_000, actualUnits: 9 }),
    ],
    july,
  );
  assert.equal(vacant.length, 2, "a row the engine could not attribute to an occupant is kept, not dropped");
  assert.equal(
    vacant.reduce((sum, aggregate) => sum + aggregate.salesValue, 0),
    490_000,
    "the company total includes vacant-area sales — losing them would under-report the company",
  );
  assert.equal(
    vacant.find((aggregate) => aggregate.repHrId === null)?.dmHrId,
    "B-119",
    "and it keeps its DM, so the manager it rolls up to is still right",
  );

  // ── HR ids come out upper-cased ────────────────────────────────────────────
  // The engine returns them lower-cased and the rest of the repo compares upper-cased. A
  // mismatch is not an error — it is an empty result that reads as "this rep sold nothing".
  assert.equal(vacant[0]?.repHrId, "B-158", "rep HR ids are upper-cased for the directory join");

  // ── Covered sales: the numerator an achievement is allowed to use ──────────
  // A product with no target anywhere is real revenue and belongs in `salesValue`, but crediting
  // it against another product's target reads as an over-achievement nobody earned.
  const coverage = aggregateCanonicalDashboardRows(
    [
      row({ period: "2026-07", productCode: "TE003", actualValue: 100_000, targetValue: 100_000 }),
      row({ period: "2026-07", productCode: "GU001", actualValue: 90_000 }),
    ],
    july,
  );
  const totals = coverage.reduce(
    (sum, aggregate) => ({
      sales: sum.sales + aggregate.salesValue,
      covered: sum.covered + aggregate.coveredSalesValue,
      target: sum.target + aggregate.targetValue,
    }),
    { sales: 0, covered: 0, target: 0 },
  );
  assert.equal(totals.sales, 190_000, "every sale is reported, targeted or not");
  assert.equal(
    totals.covered,
    100_000,
    "a product with no target stays OUT of the achievement numerator — 190% is an over-achievement nobody earned",
  );
  assert.equal(totals.target, 100_000, "and it contributes no target either");

  // ── The August trap ────────────────────────────────────────────────────────
  // 2026-08-10: ONE direct order (1,309.50 EGP) against a 17,508,935 EGP target. `has_actual`
  // cannot tell a landed month from a stray order; the distributor batch ledger can.
  const strayAugust = aggregateCanonicalDashboardRows(
    [
      row({ period: "2026-07", actualValue: 1_000_000, targetValue: 1_000_000 }),
      row({ period: "2026-08", actualValue: 1_309.5, targetValue: 17_508_935 }),
    ],
    july,
  );
  assert.deepEqual(
    strayAugust.map((aggregate) => aggregate.period),
    ["2026-07"],
    "a month with a direct order but no distributor upload is excluded, not shown as ~0%",
  );

  // ── Merged areas fold, they do not collide ─────────────────────────────────
  // applyAchievementAreaMerges rewrites Fayoum and Beni Suef onto ONE area code without summing,
  // so two rows legitimately arrive sharing (rep, period, area, product).
  const merged = aggregateCanonicalDashboardRows(
    [
      row({ period: "2026-07", areaCode: "FY1", actualValue: 300_000, actualUnits: 30, targetValue: 250_000 }),
      row({ period: "2026-07", areaCode: "FY1", actualValue: 200_000, actualUnits: 20, targetValue: 150_000 }),
    ],
    july,
  );
  assert.equal(merged.length, 1, "two rows on one merged area code fold into a single aggregate");
  assert.equal(merged[0]?.salesValue, 500_000, "both halves of a merged area count");
  assert.equal(merged[0]?.targetValue, 400_000, "and so do both halves of its target");

  // ── No fabricated sales type ───────────────────────────────────────────────
  // The canonical engine records no Retail/Stores split. A made-up token would put a channel
  // pie chart and a filter on screen that assert a split the closing does not record.
  const canonicalSource = readFileSync("src/lib/sales/dashboard-canonical.ts", "utf8");
  assert.match(
    canonicalSource,
    /const CANONICAL_SALES_TYPE = ""/,
    "sales type stays blank, so the channel chart shows its empty state instead of inventing a split",
  );

  // ── The merged area keeps BOTH halves' name ─────────────────────────────────
  // The sales fold correctly (asserted above), but the dashboard row's territory label must read
  // "Fayoum - Beni Suef", not the bare GZ6 name "Fayoum". The label is built in
  // loadAllCanonicalDashboardRecords, which needs the DB, so the guard is on the source: the
  // territory must resolve through getMergedAreaName first.
  assert.match(
    canonicalSource,
    /territory:\s*getMergedAreaName\(/,
    "dashboard territory must label the merged Pedia/CNS row as 'Fayoum - Beni Suef' via getMergedAreaName",
  );
  assert.equal(
    getMergedAreaName("pedia", "GZ6"),
    "Fayoum - Beni Suef",
    "Pedia's merged GZ6 row carries the combined Fayoum - Beni Suef name",
  );
  assert.equal(
    getMergedAreaName("anti_infective", "GZ6"),
    null,
    "Anti Infective keeps Fayoum and Beni Suef separate — it has no merged name",
  );
}
