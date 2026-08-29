/**
 * Pure per-employee aggregation over an already-built day list — never a second query, so the
 * on-screen summary and the full export can never disagree about what the day-by-day detail says.
 */

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { CompanyActivityDayRow, CompanyActivityEmployeeSummary } from "@/lib/company-activity-report/types";

export function summarizeCompanyActivityEmployee(
  employee: EmployeeDirectoryRow,
  days: CompanyActivityDayRow[],
  channels: { hasAttendanceChannel: boolean; hasCrmChannel: boolean },
): CompanyActivityEmployeeSummary {
  let workingDays = 0;
  let officePresentDays = 0;
  let crmFieldVisitDays = 0;
  let totalCrmVisits = 0;
  let campaignVisits = 0;
  let campaignVisitDays = 0;
  let leaveApprovedDays = 0;
  let leavePendingDays = 0;
  let noEntryDays = 0;
  let noSignalDays = 0;
  let conflictDays = 0;

  for (const day of days) {
    totalCrmVisits += day.crmVisitCount;
    campaignVisits += day.crmCampaignVisitCount;
    if (day.crmCampaignVisitCount > 0) campaignVisitDays += 1;
    if (day.conflict) conflictDays += 1;
    // Skips weekly_off/holiday/future AND "after_exit" (a day strictly after a terminal employee's
    // own lastWorkingDate — see reconcile.ts) alike: none of them are a working day expectation for
    // this employee, so none of them should inflate workingDays or fall into the outcome switch
    // below and get counted as a no_entry/no_signal gap against someone who no longer works here.
    if (day.dayType !== "working") continue;
    workingDays += 1;
    switch (day.outcome) {
      case "office_present":
        officePresentDays += 1;
        break;
      case "crm_field_visit":
        crmFieldVisitDays += 1;
        break;
      // A CRM-confirmed Annual Vacation day is at least as certain a leave signal as an HR-approved
      // request — folded into the same tally; the day-level detail keeps the distinct outcome.
      case "crm_leave":
      case "leave_approved":
        leaveApprovedDays += 1;
        break;
      case "leave_pending":
        leavePendingDays += 1;
        break;
      case "no_signal":
        noSignalDays += 1;
        break;
      case "no_entry":
        noEntryDays += 1;
        break;
      default:
        break;
    }
  }

  return {
    employeeHrId: employee.hrId,
    employeeName: employee.displayName || employee.fullName,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    areaName: employee.areaName,
    teamName: employee.teamName,
    regionName: employee.regionName,
    hasAttendanceChannel: channels.hasAttendanceChannel,
    hasCrmChannel: channels.hasCrmChannel,
    workingDays,
    officePresentDays,
    crmFieldVisitDays,
    totalCrmVisits,
    campaignVisits,
    campaignVisitDays,
    leaveApprovedDays,
    leavePendingDays,
    noEntryDays,
    noSignalDays,
    conflictDays,
  };
}
