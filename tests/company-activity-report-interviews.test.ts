import assert from "node:assert/strict";

import type ExcelJS from "exceljs";

import { buildVisitDetail, type CrmDetailRow } from "../src/lib/company-activity-report/crm-detail.ts";
import {
  DETAIL_COL_CONFLICT,
  generateCompanyActivityReportWorkbook,
  interviewSummaryText,
  OUTCOME_LABEL,
  SUMMARY_COL_CONFLICT,
  SUMMARY_COL_NO_ENTRY,
} from "../src/lib/company-activity-report/export.ts";
import { buildCompanyActivityInterviewDays, type CrmDayInterviewRow } from "../src/lib/company-activity-report/interview-detail.ts";
import { crmFieldVisitReason, reconcileCompanyActivityDay, type CompanyActivityDayInputs } from "../src/lib/company-activity-report/reconcile.ts";
import { summarizeCompanyActivityEmployee } from "../src/lib/company-activity-report/summary.ts";
import type { CompanyActivityInterviewDetail, CompanyActivityReport } from "../src/lib/company-activity-report/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PrivateCalendarInterviewRow } from "../src/lib/recruitment/interview-calendar.ts";

// ─────────────────────────────────────────────────────────────────────────────
// INTERVIEWS IN THE COMPANY ACTIVITY REPORT.
//
// Owner, 2026-11-18: "when the company activity report is exported the interviews are not recorded as
// daily records — the company activity report must show every record and be 100% full".
//
// What this pins:
//   1. Every interview a person sat in reaches their day: lead (unless declined) and panel, any hr-id
//      casing, on the CAIRO date of its start; a Phoenix CRM Interviews-day interview too, shown once
//      when it is a copy of a booking still on the calendar.
//   2. A working day whose only record is an interview reads "Interview", never "No Entry" — and an
//      interview never hides presence or leave.
//   3. A Phoenix CRM Interviews day names itself "Interviews", never "Admin Work".
//   4. The exported workbook carries the Interviews columns on Summary and Daily Detail, and the
//      severity banding still lands on No Entry / Conflict after the columns moved.
// ─────────────────────────────────────────────────────────────────────────────

function calendarRow(overrides: Partial<PrivateCalendarInterviewRow> = {}): PrivateCalendarInterviewRow {
  return {
    area: "Giza",
    candidateName: "Nour Samir",
    durationMinutes: 30,
    id: "booking-1",
    jobTitle: "Medical Representative",
    leadDeclined: false,
    leadHrId: "B-117",
    line: "CNS",
    outcome: "shortlisted",
    panelHrIds: [],
    platform: "in_office",
    // 08:30 UTC = 10:30 Cairo (UTC+2 in November).
    startsAt: "2026-11-03T08:30:00.000Z",
    ...overrides,
  };
}

function crmDayRow(overrides: Partial<CrmDayInterviewRow> = {}): CrmDayInterviewRow {
  return {
    activity_date: "2026-11-05",
    booking_id: null,
    candidate_name: "Omar Adel",
    duration_minutes: null,
    person_hr_id: "B-94",
    scheduled_at: "2026-11-05T09:00:00.000Z",
    source: "added",
    ...overrides,
  };
}

const WORKING = { dateIso: "2026-11-03", holidayName: null, isExpectedWorkingDay: true, isFuture: false, isHoliday: false, isWeeklyOff: false };

function dayInputs(overrides: Partial<CompanyActivityDayInputs> = {}): CompanyActivityDayInputs {
  return {
    classification: WORKING,
    crmDay: undefined,
    dateIso: "2026-11-03",
    employeeHrId: "B-117",
    hasAttendanceChannel: true,
    hasCrmChannel: true,
    hasOutage: false,
    isAfterExit: false,
    leave: undefined,
    punches: undefined,
    ...overrides,
  };
}

function interview(overrides: Partial<CompanyActivityInterviewDetail> = {}): CompanyActivityInterviewDetail {
  return {
    candidateName: "Nour Samir",
    jobTitle: "Medical Representative",
    outcome: "Shortlisted",
    part: "Lead interviewer",
    platform: "In office",
    source: "calendar",
    startsAtIso: "2026-11-03T08:30:00.000Z",
    timeLabel: "10:30 – 11:00",
    where: "Giza · CNS",
    ...overrides,
  };
}

function cellText(sheet: ExcelJS.Worksheet, row: number, col: number): string {
  const value = sheet.getRow(row).getCell(col).value;
  return value == null ? "" : String(value);
}

/** The header row of a writeTable starting at row 5 is row 6 (title, then headers). */
function headerIndex(sheet: ExcelJS.Worksheet, label: string): number {
  const header = sheet.getRow(6);
  for (let col = 1; col <= header.cellCount; col += 1) {
    if (cellText(sheet, 6, col) === label) return col;
  }
  return -1;
}

export function runCompanyActivityReportInterviewTests() {
  // ── (1) Who and when ─────────────────────────────────────────────────────────
  const days = buildCompanyActivityInterviewDays({
    calendar: [
      // Lead stored in lower case; a panel member too. Both on the roster.
      calendarRow({ leadHrId: "b-117", panelHrIds: ["AI-0007"] }),
      // A declined lead is not expected there; his panel member still is.
      calendarRow({ id: "booking-2", leadDeclined: true, leadHrId: "B-117", panelHrIds: ["B-94"], startsAt: "2026-11-03T10:00:00.000Z" }),
      // 22:30 UTC on the 3rd is 00:30 on the 4th in Cairo — the day is the Cairo day.
      calendarRow({ id: "booking-3", startsAt: "2026-11-03T22:30:00.000Z" }),
      // Outside the range — dropped.
      calendarRow({ id: "booking-4", startsAt: "2026-11-20T08:00:00.000Z" }),
      // Nobody on the roster — dropped.
      calendarRow({ id: "booking-5", leadHrId: "Z-999" }),
    ],
    crmDay: [
      // Added by hand on a Phoenix CRM Interviews day — kept.
      crmDayRow(),
      // A copy of booking-1 still on the calendar for the same person — the same interview, shown once.
      crmDayRow({ activity_date: "2026-11-03", booking_id: "booking-1", candidate_name: "Nour Samir", person_hr_id: "B-117", source: "calendar" }),
      // A copy whose booking was cancelled since — the only record left, kept.
      crmDayRow({ activity_date: "2026-11-03", booking_id: "booking-gone", candidate_name: "Hana Fathy", person_hr_id: "B-117", source: "calendar", scheduled_at: null }),
    ],
    employeeHrIds: ["B-117", "AI-0007", "B-94"],
    endDate: "2026-11-10",
    startDate: "2026-11-01",
  });

  const lead = days.get("B-117");
  assert.ok(lead, "the lead interviewer is found whatever case the booking stored his hr id in");
  const leadDay = lead.get("2026-11-03") ?? [];
  assert.deepEqual(
    leadDay.map((entry) => entry.candidateName),
    ["Nour Samir", "Hana Fathy"],
    "booking-1 once (its calendar copy collapsed), the declined booking-2 absent, the cancelled booking's copy kept",
  );
  assert.equal(leadDay[0].part, "Lead interviewer");
  assert.equal(leadDay[0].timeLabel, "10:30 – 11:00", "Cairo wall clock, never UTC");
  assert.equal(leadDay[0].outcome, "Shortlisted", "the recorded outcome travels as its label, never the code");
  assert.equal(leadDay[0].where, "Giza · CNS");
  assert.equal(leadDay[1].timeLabel, null, "a record with no time says nothing rather than inventing one");
  assert.equal(lead.get("2026-11-04")?.length, 1, "an interview starting 00:30 Cairo belongs to the Cairo day");
  assert.equal(lead.has("2026-11-20"), false, "out-of-range interviews are dropped");

  assert.equal(days.get("AI-0007")?.get("2026-11-03")?.[0]?.part, "Panel", "a panel member gets the interview as Panel");
  const b94 = days.get("B-94");
  assert.equal(b94?.get("2026-11-03")?.[0]?.part, "Panel", "the panel member of a declined lead's interview still has it");
  assert.equal(b94?.get("2026-11-05")?.[0]?.part, "Recorded on the Phoenix CRM Interviews day", "a hand-added Interviews-day interview is a record");
  assert.equal(days.has("Z-999"), false, "nobody off the roster is reported");

  // ── (2) The day's outcome ────────────────────────────────────────────────────
  const onlyInterview = reconcileCompanyActivityDay(dayInputs({ interviews: [interview()] }));
  assert.equal(onlyInterview.outcome, "interview", "a working day whose only record is an interview is NOT a No Entry day");
  assert.equal(onlyInterview.interviewCount, 1);
  assert.match(onlyInterview.reason, /1 interview recorded/);

  const nothing = reconcileCompanyActivityDay(dayInputs());
  assert.equal(nothing.outcome, "no_entry", "with no interview the empty day is still No Entry");
  assert.deepEqual(nothing.interviews, [], "a day with no interview carries an empty list, never undefined");

  const onLeave = reconcileCompanyActivityDay(dayInputs({
    interviews: [interview()],
    leave: { covered: true, dayPart: "full_day", id: "l-1", managerDecision: "approved", notes: null, status: "approved", vacationType: "annual" },
  }));
  assert.equal(onLeave.outcome, "leave_approved", "an interview never hides a leave signal");
  assert.equal(onLeave.interviewCount, 1, "…and the interview is still listed on that day");

  const inOffice = reconcileCompanyActivityDay(dayInputs({
    interviews: [interview()],
    punches: { firstPunchMinutes: 540, lastPunchMinutes: 1020, visiblePunchCount: 2 },
  }));
  assert.equal(inOffice.outcome, "office_present", "presence still wins the day");
  assert.equal(inOffice.interviewCount, 1);

  const weeklyOff = reconcileCompanyActivityDay(dayInputs({
    classification: { ...WORKING, isWeeklyOff: true },
    interviews: [interview(), interview({ candidateName: "Second" })],
  }));
  assert.equal(weeklyOff.outcome, "weekly_off");
  assert.equal(weeklyOff.interviewCount, 2, "a weekly-off interview is still a record on its day");

  const employee = { displayName: "Ahmed Kamal", fullName: "Ahmed Kamal", hrId: "B-117" } as EmployeeDirectoryRow;
  const summary = summarizeCompanyActivityEmployee(employee, [onlyInterview, nothing, onLeave, weeklyOff], {
    hasAttendanceChannel: true,
    hasCrmChannel: true,
  });
  assert.equal(summary.interviewCount, 4, "every interview in range counts, weekly-off included");
  assert.equal(summary.interviewDays, 3);
  assert.equal(summary.interviewOnlyDays, 1);
  assert.equal(summary.noEntryDays, 1, "the interview-only day is not counted as No Entry");

  // ── (3) A Phoenix CRM Interviews day names itself ───────────────────────────
  const interviewsDayVisit = buildVisitDetail(
    {
      agent_hr_id: "B-117",
      comment: "Interviews Physical interview for Dokki",
      visit_type: -20,
      visit_type_description: "Admin Work",
    } as CrmDetailRow,
    null,
  );
  assert.equal(interviewsDayVisit.label, "Interviews", "the Interviews day reads Interviews, never Admin Work");
  assert.equal(interviewsDayVisit.comment, "Physical interview for Dokki", "the door's prefix is not printed twice");
  const plainAdmin = buildVisitDetail({ agent_hr_id: "B-117", comment: "Reports", visit_type: -20, visit_type_description: "Admin Work" } as CrmDetailRow, null);
  assert.equal(plainAdmin.label, "Admin Work", "ordinary Admin work keeps its own label");
  assert.equal(crmFieldVisitReason([interviewsDayVisit]), "CRM day activity recorded: Interviews.");

  // ── (4) The workbook ────────────────────────────────────────────────────────
  const report: CompanyActivityReport = {
    days: [onlyInterview],
    endDate: "2026-11-03",
    holidayCalendarReachable: true,
    interviewSourcesReachable: true,
    startDate: "2026-11-03",
    summaries: [summary],
    unmappedCrmVisitCount: null,
  };
  const workbook = generateCompanyActivityReportWorkbook({ employeeNameByHrId: new Map([["B-117", "Ahmed Kamal"]]), report });

  const detail = workbook.getWorksheet("Daily Detail");
  assert.ok(detail);
  const countCol = headerIndex(detail, "Interviews");
  const textCol = headerIndex(detail, "Interview Details");
  assert.ok(countCol > 0 && textCol > 0, "Daily Detail carries an Interviews count and an Interview Details column");
  assert.equal(cellText(detail, 7, countCol), "1");
  assert.match(cellText(detail, 7, textCol), /10:30 – 11:00 Nour Samir — Medical Representative \(Lead interviewer · In office · Giza · CNS · Outcome: Shortlisted\)/);
  assert.equal(cellText(detail, 7, 6), OUTCOME_LABEL.interview, "the Outcome cell reads Interview");
  assert.equal(headerIndex(detail, "Conflict"), DETAIL_COL_CONFLICT, "the conflict banding still lands on the Conflict column");

  const summarySheet = workbook.getWorksheet("Summary");
  assert.ok(summarySheet);
  assert.ok(headerIndex(summarySheet, "Interviews") > 0 && headerIndex(summarySheet, "Interview Days") > 0);
  assert.equal(headerIndex(summarySheet, "No Entry Days"), SUMMARY_COL_NO_ENTRY, "No Entry banding still lands on No Entry Days");
  assert.equal(headerIndex(summarySheet, "Conflict Days"), SUMMARY_COL_CONFLICT, "Conflict banding still lands on Conflict Days");

  assert.equal(interviewSummaryText({ ...onlyInterview, interviews: [] }), "", "a day with no interview prints an empty cell");

  // An unreadable source is SAID, never a silent zero.
  const partial = generateCompanyActivityReportWorkbook({
    employeeNameByHrId: new Map(),
    report: { ...report, interviewSourcesReachable: false },
  });
  const notes = partial.getWorksheet("Notes & Legend");
  assert.ok(notes);
  let saysMissing = false;
  notes.eachRow((row) => {
    row.eachCell((cell) => {
      if (String(cell.value ?? "").includes("could NOT be read for this export — interviews may be missing")) saysMissing = true;
    });
  });
  assert.ok(saysMissing, "an unreadable interview source is stated in the workbook");
}
