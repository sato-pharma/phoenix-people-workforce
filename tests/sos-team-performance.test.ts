import assert from "node:assert/strict";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { activePeriodsOf } from "../src/lib/employee-portal/sos-team-performance.ts";

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-08",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "AB1",
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: "1001",
    dmSeatId: null,
    dmHrId: "1002",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...overrides,
  };
}

export function runSosTeamPerformanceTests() {
  // ── A month with no published Monthly Closing must not activate ──────────────────
  // [Owner ruling, 2026-08-13]: a live dashboard may only count a period once that
  // line's Monthly Closing is PUBLISHED — a later, admin-gated action, not merely a
  // landed distributor upload. `hasActual` alone previously said a month was "in" (the
  // 2026-08-10 stray-Direct-Order regression: 1,309.50 EGP pulled the FULL month's
  // target into every manager's default cumulative keycard denominator against almost
  // no actual, roughly halving every keycard's default achievement %). A period counts
  // as active only when its OWN (lineCode, period) key is in `publishedKeys` — see
  // isRowPublished / loadPublishedPeriodKeys in vs-target.ts.
  const julyPublished = new Set(["cns|2026-07"]);

  const unpublishedAugustOnly = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-08", actualValue: 1309.5, targetValue: 4738.5, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(unpublishedAugustOnly, julyPublished),
    ["2026-07"],
    "a month whose Monthly Closing has not been published must not activate — it would pull the full month's target into the default cumulative view against sales nobody has closed yet",
  );

  // ── A month WITH a published Monthly Closing is active once it has actual ────────
  const bothPublished = new Set(["cns|2026-07", "cns|2026-08"]);
  const twoRealMonths = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-08", actualValue: 60000, targetValue: 549702.94, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(twoRealMonths, bothPublished),
    ["2026-08", "2026-07"],
    "once a month's Monthly Closing is published, its actual sales activate it normally, newest first",
  );

  // ── A future-target-only month stays excluded even if it is published ────────────
  // Existing behavior (pre-dating this fix) must survive: a month that carries a target
  // but zero actual sales is not a reporting period, regardless of publication status.
  const targetOnlyButPublished = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-09", actualValue: 0, targetValue: 549702.94, hasTarget: true, hasActual: false }),
  ];
  assert.deepEqual(
    activePeriodsOf(targetOnlyButPublished, new Set(["cns|2026-07", "cns|2026-09"])),
    ["2026-07"],
    "a month with only a future target and zero actual sales stays excluded even though it is in publishedKeys",
  );

  // ── A row's line must match the published key's line, not just the period ────────
  // monthly_closing_publications keys per (line, period): a CNS row in a period where
  // only Pedia published must NOT read as active — the old period-only Set could not
  // express this and would have silently activated every line at once.
  const wrongLinePublished = [
    row({ period: "2026-07", lineCode: "cns", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(wrongLinePublished, new Set(["pedia|2026-07"])),
    [],
    "a published key for a different line must not activate this row's line",
  );

  // ── Sorted newest-first and de-duplicated ─────────────────────────────────────────
  const threeMonthsUnordered = [
    row({ period: "2026-08", actualValue: 100, hasActual: true }),
    row({ period: "2026-07", actualValue: 100, hasActual: true }),
    row({ period: "2026-07", productCode: "P2", actualValue: 50, hasActual: true }),
    row({ period: "2026-09", actualValue: 100, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(threeMonthsUnordered, new Set(["cns|2026-07", "cns|2026-08", "cns|2026-09"])),
    ["2026-09", "2026-08", "2026-07"],
    "active periods are de-duplicated and sorted newest first",
  );
}
