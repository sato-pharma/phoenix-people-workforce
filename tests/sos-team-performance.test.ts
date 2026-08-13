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
  // ── The 2026-08-10 regression: one stray Direct Order must not activate a month ──
  // On 2026-08-10 a single Direct Order (1,309.50 EGP, area GZ1) landed in August 2026
  // before that month's real distributor files arrived. `hasActual` alone said August was
  // "in", which pulled August's FULL target into every manager's default cumulative
  // keycard denominator while contributing almost no actual — roughly halving every
  // keycard's default achievement %. A period counts as active only when it ALSO appears
  // in `uploadedPeriods` (the real distributor-batch ledger `/sales/vs-target` already
  // uses for the identical failure — see loadUploadedPeriods in vs-target.ts).
  const julyUploaded = new Set(["2026-07"]);

  const strayDirectOrderOnly = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-08", actualValue: 1309.5, targetValue: 4738.5, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(strayDirectOrderOnly, julyUploaded),
    ["2026-07"],
    "a month whose only actual is a Direct Order booked before its distributor upload landed must not activate — it would pull the full month's target into the default cumulative view against almost no actual",
  );

  // ── A month WITH a landed distributor upload is active once it has actual ────────
  const bothUploaded = new Set(["2026-07", "2026-08"]);
  const twoRealMonths = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-08", actualValue: 60000, targetValue: 549702.94, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(twoRealMonths, bothUploaded),
    ["2026-08", "2026-07"],
    "once a month's real distributor upload has landed, its actual sales activate it normally, newest first",
  );

  // ── A future-target-only month stays excluded even if its upload has landed ──────
  // Existing behavior (pre-dating this fix) must survive: a month that carries a target
  // but zero actual sales is not a reporting period, regardless of upload status.
  const targetOnlyButUploaded = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-09", actualValue: 0, targetValue: 549702.94, hasTarget: true, hasActual: false }),
  ];
  assert.deepEqual(
    activePeriodsOf(targetOnlyButUploaded, new Set(["2026-07", "2026-09"])),
    ["2026-07"],
    "a month with only a future target and zero actual sales stays excluded even though it is in uploadedPeriods",
  );

  // ── Sorted newest-first and de-duplicated ─────────────────────────────────────────
  const threeMonthsUnordered = [
    row({ period: "2026-08", actualValue: 100, hasActual: true }),
    row({ period: "2026-07", actualValue: 100, hasActual: true }),
    row({ period: "2026-07", productCode: "P2", actualValue: 50, hasActual: true }),
    row({ period: "2026-09", actualValue: 100, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(threeMonthsUnordered, new Set(["2026-07", "2026-08", "2026-09"])),
    ["2026-09", "2026-08", "2026-07"],
    "active periods are de-duplicated and sorted newest first",
  );
}
