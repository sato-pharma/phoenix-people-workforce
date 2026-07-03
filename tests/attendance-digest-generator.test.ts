import { strict as assert } from "node:assert";

import {
  buildEmployeeWeekDigest,
  deductionValueEgp,
  type DigestDayInput,
} from "../src/lib/attendance/digest-generator.ts";
import type { DeductionBracket, FlexibleHoursConfig } from "../src/lib/attendance/flexible-hours.ts";
import type { ReconcileInput } from "../src/lib/attendance/digest-reconcile.ts";

const CONFIG: FlexibleHoursConfig = {
  scheduledStartMinutes: 540,
  flexCeilingMinutes: 570,
  requiredMinutes: 470,
};
const LATE_BRACKETS: DeductionBracket[] = [
  { fromMinutes: 1, toMinutes: 15, deductionDays: 0.25 },
  { fromMinutes: 16, toMinutes: 30, deductionDays: 0.5 },
  { fromMinutes: 31, toMinutes: 45, deductionDays: 0.75 },
  { fromMinutes: 46, toMinutes: null, deductionDays: 1 },
];
const SHORT_BRACKETS: DeductionBracket[] = [
  { fromMinutes: 1, toMinutes: 15, deductionDays: 0.25 },
  { fromMinutes: 16, toMinutes: 30, deductionDays: 0.25 },
  { fromMinutes: 31, toMinutes: 45, deductionDays: 0.5 },
  { fromMinutes: 46, toMinutes: null, deductionDays: 1 },
];
const at = (h: number, m: number) => h * 60 + m;

function tier1(reconcile: Partial<ReconcileInput>): ReconcileInput {
  return {
    tier: "every_working_day",
    isWorkingDay: true,
    isHoliday: false,
    hasApprovedLeave: false,
    hasApprovedExcuse: false,
    planSaysOffice: null,
    hasPunch: true,
    deviceOutage: false,
    ...reconcile,
  };
}

function day(
  dateIso: string,
  reconcile: ReconcileInput,
  first: number | null,
  last: number | null,
  count: number,
): DigestDayInput {
  return {
    dateIso,
    reconcile,
    firstPunchMinutes: first,
    lastPunchMinutes: last,
    visiblePunchCount: count,
    config: CONFIG,
    lateBrackets: LATE_BRACKETS,
    shortBrackets: SHORT_BRACKETS,
  };
}

export function runAttendanceDigestGeneratorTests() {
  // --- deductionValueEgp: matches the owner's "late 15 min -> 1/4 day -> 200 EGP" example ---
  assert.equal(deductionValueEgp(24000, 0.25), 200, "24000 / 30 * 0.25 = 200 EGP");
  assert.equal(deductionValueEgp(24000, 0), 0);
  assert.equal(deductionValueEgp(null, 0.5), 0, "no salary -> no value");

  const digest = buildEmployeeWeekDigest({
    baseSalary: 24000,
    days: [
      day("2026-06-24", tier1({}), at(10, 0), at(17, 50), 2), // late but hours done -> 0.25 (200 EGP)
      day("2026-06-25", tier1({}), at(9, 20), at(16, 50), 2), // short 20 -> 0.25 (200 EGP)
      day("2026-06-26", tier1({}), at(9, 15), at(17, 5), 2), // complete -> no line
      day("2026-06-27", tier1({ isWorkingDay: false }), null, null, 0), // weekend -> skip
      day("2026-06-28", tier1({ isHoliday: true }), at(10, 0), at(17, 0), 2), // holiday -> skip
      day("2026-06-29", tier1({ hasPunch: true }), at(10, 0), null, 1), // one punch -> missing-punch line
    ],
  });

  assert.equal(digest.lines.length, 3, "two deductible days + one missing-punch line");
  const byDate = new Map(digest.lines.map((line) => [line.dateIso, line]));

  assert.equal(byDate.get("2026-06-24")!.status, "late");
  assert.equal(byDate.get("2026-06-24")!.deductionDays, 0.25);
  assert.equal(byDate.get("2026-06-24")!.deductionValue, 200);

  assert.equal(byDate.get("2026-06-25")!.status, "short_hours");
  assert.equal(byDate.get("2026-06-25")!.deductionValue, 200);

  const missing = byDate.get("2026-06-29")!;
  assert.equal(missing.status, "missing_punch");
  assert.equal(missing.deductionDays, 0, "missing punch is never auto-deducted");
  assert.equal(missing.deductionValue, 0);

  assert.equal(digest.totalDeductionDays, 0.5, "0.25 + 0.25 + 0");
  assert.equal(digest.totalDeductionValue, 400, "200 + 200 + 0");
  assert.equal(digest.flags.length, 0);

  // --- Tier-2 flags: plan office + no punch -> office no-show flag, no line ---
  const tier2 = buildEmployeeWeekDigest({
    baseSalary: 30000,
    days: [
      day(
        "2026-06-24",
        { tier: "office_days_only", isWorkingDay: true, isHoliday: false, hasApprovedLeave: false, hasApprovedExcuse: false, planSaysOffice: true, hasPunch: false, deviceOutage: false },
        null,
        null,
        0,
      ),
    ],
  });
  assert.equal(tier2.lines.length, 0, "a flagged day produces no deductible line");
  assert.equal(tier2.flags.length, 1);
  assert.equal(tier2.flags[0].flagType, "office_no_show");
}
