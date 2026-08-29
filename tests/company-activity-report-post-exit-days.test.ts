import assert from "node:assert/strict";

import { reconcileCompanyActivityDay, type CompanyActivityDayInputs } from "../src/lib/company-activity-report/reconcile.ts";
import { isDayAfterEmployeeExit } from "../src/lib/company-activity-report/service.ts";

/**
 * PR #2717 fixed the Company Activity Report so a resigned/terminated employee whose
 * lastWorkingDate falls before the report's requested startDate is dropped from the roster
 * entirely (filters.ts's filterCompanyActivityEmployees, pinned by
 * tests/leaver-roster-exclusion.test.ts). That fix bounds ROSTER INCLUSION only — it never bounded
 * the PER-DAY detail generated for someone who exits PARTWAY through an already-included range.
 *
 * Confirmed against production 2026-08-30: several currently resigned employees (e.g. hr_id
 * B-175, last_working_date 2026-08-03) still pass the roster filter for a "This Month" report
 * because their exit date is on/after the range start, and every working day AFTER they left but
 * still inside the range was rendering as "no_entry" — "No activity recorded." — the exact
 * fabricated-absence-for-someone-who-no-longer-works-here shape #2717 was written to kill,
 * reappearing at day granularity instead of employee granularity.
 *
 * The fix: service.ts's isDayAfterEmployeeExit is the pure per-day boundary check (terminal
 * employment status + dateIso strictly after lastWorkingDate), threaded into reconcile.ts as
 * `isAfterExit`, which gives such a day its own "after_exit" outcome/dayType instead of falling
 * through the normal working/no_entry precedence chain at all.
 */

const WORKING_CLASSIFICATION = {
  dateIso: "2026-08-20",
  holidayName: null,
  isExpectedWorkingDay: true,
  isFuture: false,
  isHoliday: false,
  isWeeklyOff: false,
};

function dayInputs(overrides: Partial<CompanyActivityDayInputs> = {}): CompanyActivityDayInputs {
  return {
    classification: WORKING_CLASSIFICATION,
    crmDay: undefined,
    dateIso: "2026-08-20",
    employeeHrId: "B-175",
    hasAttendanceChannel: true,
    hasCrmChannel: true,
    hasOutage: false,
    isAfterExit: false,
    leave: undefined,
    punches: undefined,
    ...overrides,
  };
}

export function runCompanyActivityReportPostExitDaysTests() {
  // ── isDayAfterEmployeeExit — the pure per-day boundary check ──
  const terminal = { employmentStatus: "resigned", lastWorkingDate: "2026-08-15" };
  const active = { employmentStatus: "active", lastWorkingDate: "2026-08-15" };

  assert.equal(isDayAfterEmployeeExit(terminal, "2026-08-16"), true, "the day right after lastWorkingDate is after-exit");
  assert.equal(isDayAfterEmployeeExit(terminal, "2026-08-31"), true, "any later day in range is still after-exit");
  assert.equal(isDayAfterEmployeeExit(terminal, "2026-08-15"), false, "the exit date itself is NOT after-exit — still a normal day for them");
  assert.equal(isDayAfterEmployeeExit(terminal, "2026-08-14"), false, "a day before the exit date is unaffected");
  assert.equal(
    isDayAfterEmployeeExit({ employmentStatus: "resigned", lastWorkingDate: null }, "2099-01-01"),
    false,
    "an unknown exit date never marks a day as after-exit — the roster filter already drops these employees entirely for a bounded range",
  );

  // ── (3) An active (non-terminal) employee's days are entirely unaffected, for any date
  //    including far-future dates — this boundary only ever fires for a CONFIRMED terminal
  //    employee. ──
  assert.equal(isDayAfterEmployeeExit(active, "2026-08-16"), false, "active employment status means never after-exit, even past a stale lastWorkingDate value");
  assert.equal(isDayAfterEmployeeExit(active, "2099-12-31"), false, "an active employee's far-future day is unaffected");
  assert.equal(
    isDayAfterEmployeeExit({ employmentStatus: null, lastWorkingDate: "2026-08-01" }, "2099-01-01"),
    false,
    "an unset employment status is treated as active (isTerminalEmploymentStatus's own rule), never after-exit",
  );

  // ── (1) A working day strictly after exit never resolves to no_entry/no_signal or any outcome
  //    implying ongoing employment — even when the underlying signals are IDENTICAL to a genuine
  //    gap (no punch, no CRM, no leave, no outage), i.e. exactly what would otherwise classify as
  //    a normal working day with no signal. ──
  const afterExitNoEntry = reconcileCompanyActivityDay(dayInputs({ isAfterExit: true }));
  assert.equal(afterExitNoEntry.outcome, "after_exit", "a would-be no_entry day after exit gets its own outcome, not no_entry");
  assert.equal(afterExitNoEntry.dayType, "after_exit");
  assert.notEqual(afterExitNoEntry.outcome, "no_entry");
  assert.notEqual(afterExitNoEntry.outcome, "no_signal");
  assert.ok(!/no activity recorded/i.test(afterExitNoEntry.reason), "the reason must not read as an unexplained gap");
  assert.ok(!/no signal/i.test(afterExitNoEntry.reason), "the reason must not read as a monitoring blind spot either");
  assert.ok(/no longer employed/i.test(afterExitNoEntry.reason), "the reason must say plainly that this employee no longer works here");

  const afterExitNoSignal = reconcileCompanyActivityDay(dayInputs({
    hasAttendanceChannel: false,
    hasCrmChannel: false,
    isAfterExit: true,
  }));
  assert.equal(afterExitNoSignal.outcome, "after_exit", "even with neither channel resolved, an after-exit day is after_exit, never no_signal");
  assert.equal(afterExitNoSignal.hasNoSignal, true, "hasNoSignal stays a true data fact about channel resolution — only the day's OUTCOME is overridden");

  // Real activity recorded after exit (a late CRM sync / same-day settlement edge case) is still
  // classified after_exit at the headline level — after-exit is not merely a no_entry override, it
  // takes priority over the WHOLE working-day precedence chain — but the underlying evidence is
  // not thrown away: it is still returned on the row for the detail view/export to show.
  const afterExitWithRealActivity = reconcileCompanyActivityDay(dayInputs({
    crmDay: { isFieldVisitDay: true, isLeaveDay: false, visits: [] },
    isAfterExit: true,
    punches: { firstPunchMinutes: 480, lastPunchMinutes: 720, visiblePunchCount: 1 },
  }));
  assert.equal(afterExitWithRealActivity.outcome, "after_exit", "after-exit outranks real presence/CRM evidence at the headline level");
  assert.equal(afterExitWithRealActivity.hasOfficePunch, true, "the real punch fact is still surfaced on the row, not discarded");
  assert.equal(afterExitWithRealActivity.conflict, false, "conflict only ever applies to dayType 'working' — an after_exit day is never flagged as a conflict");

  // ── (2) ON the exit date, and every day before it, behavior is completely unaffected — both
  //    for a genuine gap and for a legitimate no-signal day. ──
  const onExitDateNoEntry = reconcileCompanyActivityDay(dayInputs({ isAfterExit: false }));
  assert.equal(onExitDateNoEntry.outcome, "no_entry", "isAfterExit=false leaves the existing no_entry fallback completely untouched");
  assert.equal(onExitDateNoEntry.dayType, "working");

  const onExitDateNoSignal = reconcileCompanyActivityDay(dayInputs({
    hasAttendanceChannel: false,
    hasCrmChannel: false,
    isAfterExit: false,
  }));
  assert.equal(onExitDateNoSignal.outcome, "no_signal", "isAfterExit=false leaves the existing no_signal fallback completely untouched");

  const beforeExitRealActivity = reconcileCompanyActivityDay(dayInputs({
    crmDay: { isFieldVisitDay: true, isLeaveDay: false, visits: [] },
    isAfterExit: false,
  }));
  assert.equal(beforeExitRealActivity.outcome, "crm_field_visit", "a genuine working day on/before exit still reports real activity exactly as before this change");

  // Weekly-off / holiday / future classification still takes priority over after_exit — this fix
  // only ever touches the ordinary working-day fallback, never recolors a calendar-level day type.
  const weeklyOffAfterExit = reconcileCompanyActivityDay(dayInputs({
    classification: { ...WORKING_CLASSIFICATION, isWeeklyOff: true },
    isAfterExit: true,
  }));
  assert.equal(weeklyOffAfterExit.outcome, "weekly_off", "a weekly-off day keeps its own label even after exit — calendar classification is untouched by this fix");

  const futureAfterExit = reconcileCompanyActivityDay(dayInputs({
    classification: { ...WORKING_CLASSIFICATION, isFuture: true },
    isAfterExit: true,
  }));
  assert.equal(futureAfterExit.outcome, "future", "a future date keeps its own label even for a terminal employee whose exit date is also in the future");
}
