/**
 * Per-employee-per-day merge for the Company Activity Report — an independent precedence chain,
 * NOT a reuse of digest-reconcile.ts's reconcileDay: that engine answers a payroll question
 * (should this day be judged for a deduction, and at what tier), this answers a different one
 * (what actually happened). It reuses the underlying FACT SOURCES (classifyAttendanceDay, company
 * outage detection, CRM day classification, leave detail) but never payroll's flex-hour tiers or
 * deduction brackets.
 *
 * Precedence on a working day: an office punch or a real CRM field visit is PHYSICAL PRESENCE
 * evidence and is shown first. Next come the LEAVE signals (CRM-reported Annual Vacation, then
 * Phoenix leave by real status) — these are independently sourced and never depend on punch data,
 * so they must never be shadowed by a device outage. Only once none of those apply does a
 * company-wide device outage get to explain the remaining silence; below that, no-signal, then
 * no-entry. A conflict — presence evidence AND a leave signal on the same day — is flagged
 * independently rather than silently resolved either way, per the owner's explicit "not payroll,
 * show what actually happened" ruling.
 *
 * `isAfterExit` (a day strictly after a TERMINAL employee's own lastWorkingDate — computed once
 * per employee-day in service.ts's isDayAfterEmployeeExit) sits ABOVE the whole working-day
 * precedence chain above but BELOW future/weekly_off/holiday: a leaver's calendar day is still a
 * calendar day (an actual holiday stays "Holiday.", not recolored), but once none of those apply,
 * a day after exit never falls through into no_entry/no_signal/office_present/etc — those all
 * either fabricate an absence or imply ongoing employment for someone who no longer works here.
 * The underlying facts (punches, CRM visits, leave) are still computed and returned on the row
 * regardless — only the headline dayType/outcome is overridden — so a rare late-sync edge case
 * (real activity recorded after an exit date) is never silently hidden from the detail view/export.
 */

import type { AttendanceDayClassification } from "@/lib/attendance/working-days";
import type { EmployeeDayPunches } from "@/lib/attendance/punch-minutes";
import type { CompanyActivityCrmDay } from "@/lib/company-activity-report/crm-detail";
import type { CompanyActivityDayOutcome, CompanyActivityDayRow, CompanyActivityLeaveDetail } from "@/lib/company-activity-report/types";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekdayName(dateIso: string): string {
  return WEEKDAY_NAMES[new Date(`${dateIso}T00:00:00Z`).getUTCDay()];
}

export type CompanyActivityDayInputs = {
  employeeHrId: string;
  dateIso: string;
  classification: AttendanceDayClassification;
  punches: EmployeeDayPunches | undefined;
  crmDay: CompanyActivityCrmDay | undefined;
  leave: CompanyActivityLeaveDetail | undefined;
  hasOutage: boolean;
  hasAttendanceChannel: boolean;
  hasCrmChannel: boolean;
  /** True when this specific date is strictly after a TERMINAL employee's own lastWorkingDate —
   * see service.ts's isDayAfterEmployeeExit. Always false for an active/on_leave employee, and
   * always false on/before the exit date itself. */
  isAfterExit: boolean;
};

export function reconcileCompanyActivityDay(input: CompanyActivityDayInputs): CompanyActivityDayRow {
  const { classification } = input;
  const weekday = weekdayName(input.dateIso);
  const crmVisits = input.crmDay?.visits ?? [];
  const hasOfficePunch = Boolean(input.punches && input.punches.visiblePunchCount > 0);
  const hasCrmFieldVisit = Boolean(input.crmDay?.isFieldVisitDay);
  const hasCrmLeave = Boolean(input.crmDay?.isLeaveDay);
  const leaveApproved = Boolean(input.leave?.covered);
  const leavePending = Boolean(input.leave) && !leaveApproved;
  const hasNoSignal = !input.hasAttendanceChannel && !input.hasCrmChannel;

  let dayType: CompanyActivityDayRow["dayType"];
  let outcome: CompanyActivityDayOutcome;
  let reason: string;

  if (classification.isFuture) {
    dayType = "future";
    outcome = "future";
    reason = "In the future.";
  } else if (classification.isWeeklyOff) {
    dayType = "weekly_off";
    outcome = "weekly_off";
    reason = "Weekly off.";
  } else if (classification.isHoliday) {
    dayType = "holiday";
    outcome = "holiday";
    reason = classification.holidayName ? `Holiday: ${classification.holidayName}.` : "Holiday.";
  } else if (input.isAfterExit) {
    // Checked before ANY of the working-day signals below — an employee who no longer works here
    // does not get judged on whether they punched in, had a CRM visit, or requested leave that day.
    dayType = "after_exit";
    outcome = "after_exit";
    reason = "No longer employed here — this date is after the employee's last working date.";
  } else {
    dayType = "working";
    if (hasOfficePunch) {
      outcome = "office_present";
      reason = "Office attendance recorded.";
    } else if (hasCrmFieldVisit) {
      outcome = "crm_field_visit";
      reason = "CRM field visit recorded.";
    } else if (hasCrmLeave) {
      outcome = "crm_leave";
      reason = "CRM recorded as Annual Vacation.";
    } else if (leaveApproved) {
      outcome = "leave_approved";
      reason = `Leave approved (${input.leave?.vacationType ?? "vacation"}).`;
    } else if (leavePending) {
      outcome = "leave_pending";
      reason = `Leave pending — status: ${input.leave?.status ?? "pending"}.`;
    } else if (input.hasOutage) {
      // Checked only once every INDEPENDENT signal (punch, CRM visit, CRM leave, Phoenix leave) is
      // ruled out — a device outage explains a missing PUNCH, never a missing leave record, so it
      // must never outrank a leave signal that has nothing to do with punch data.
      outcome = "device_outage";
      reason = "Company-wide device outage — no punch data available that day.";
    } else if (hasNoSignal) {
      outcome = "no_signal";
      reason = "No attendance device or Phoenix CRM seat on record for this employee.";
    } else {
      outcome = "no_entry";
      reason = "No activity recorded.";
    }
  }

  const conflict =
    dayType === "working" && (hasOfficePunch || hasCrmFieldVisit) && (hasCrmLeave || leaveApproved || leavePending);

  return {
    employeeHrId: input.employeeHrId,
    dateIso: input.dateIso,
    weekday,
    dayType,
    outcome,
    reason,
    crmVisits,
    crmVisitCount: crmVisits.length,
    crmCampaignVisitCount: crmVisits.filter((visit) => visit.isCampaign).length,
    hasOfficePunch,
    firstPunchMinutes: input.punches?.firstPunchMinutes ?? null,
    lastPunchMinutes: input.punches?.lastPunchMinutes ?? null,
    leave: input.leave ?? null,
    hasNoSignal,
    conflict,
  };
}
