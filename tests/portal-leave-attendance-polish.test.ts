import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  countLateOrEarlyDays,
  isLateOrEarlyDay,
  mergeNoRecordDays,
  noRecordWorkingDays,
  workedHoursLabel,
} from "../src/lib/attendance/attendance-day-display.ts";
import { explainerPolicyName } from "../src/lib/attendance/policy-explainer.ts";
import { claimsLabel, isPassedValidation, summarizeMyClaims } from "../src/lib/outstation/my-claims-summary.ts";
import { employeeHolidayList } from "../src/lib/vacation/employee-holiday-list.ts";
import type { EgyptianNationalHoliday } from "../src/lib/vacation/national-holidays.ts";
import { overlapWarningsLabel, showsDailySlaRunCard, vacationDaysLabel } from "../src/lib/vacation/report-display.ts";

// Employee-portal polish (owner, 2026-10-26, seen signed in as a National Sales Manager). Each block
// pins one logic fix; all of them are display only — no money, balance or approval rule moves.

function myClaimsCardAgreesWithTheRows() {
  // Submit Expense: claims HR approved AS CLAIMED (hr_approved, no approved amount) read "Passed
  // validation" in their rows while the card, counting only an approved amount, said none.
  const approvedAsClaimed = { claimedTotalAmount: 500, decision: { approvedAmount: null, hrApproved: true }, isPayrollEligible: true, status: "In payroll" };
  const approvedChanged = { claimedTotalAmount: 400, decision: { approvedAmount: 300, hrApproved: true }, isPayrollEligible: true, status: "In payroll" };
  const undecided = { claimedTotalAmount: 200, decision: null, isPayrollEligible: false, status: "Submitted" };
  const rejected = { claimedTotalAmount: 100, decision: { approvedAmount: 0, hrApproved: false }, isPayrollEligible: true, status: "Rejected" };

  assert.equal(isPassedValidation(approvedAsClaimed), true, "a claim approved as claimed has passed validation");
  assert.equal(isPassedValidation(approvedChanged), true);
  assert.equal(isPassedValidation(undecided), false);
  assert.equal(isPassedValidation(rejected), false, "a rejected claim never counts as validated");

  const summary = summarizeMyClaims([approvedAsClaimed, approvedChanged, undecided, rejected]);
  assert.equal(summary.validatedCount, 2, "the card counts every row that reads Passed validation");
  assert.equal(summary.validatedAmount, 800, "approved as claimed pays the claim (500); a changed amount pays what HR typed (300)");
  assert.equal(summary.claimed, 1200);
  assert.equal(summary.awaiting, 1);
  assert.equal(claimsLabel(1), "1 claim");
  assert.equal(claimsLabel(3), "3 claims");

  const component = readFileSync(new URL("../src/components/outstation/my-expense-submissions.tsx", import.meta.url), "utf8");
  assert.match(component, /summarizeMyClaims\(/, "the card reads the shared summary");
  assert.match(component, /isPassedValidation\(/, "the row's Validation stage reads the same test as the card");
}

function holiday(
  partial: Partial<EgyptianNationalHoliday> & Pick<EgyptianNationalHoliday, "id" | "name" | "startDate">,
): EgyptianNationalHoliday {
  return { description: null, durationDays: 1, endDate: null, source: "company", ...partial };
}

function nationalHolidaysTabShowsOneRowAndNoOwnerNotes() {
  const list = employeeHolidayList([
    holiday({ description: "moved by HR, internal note", id: "override-19", name: "Armed Forces Day", startDate: "2026-10-08" }),
    holiday({ description: "confirmed by owner", id: "override-2", name: "Day off for Armed Forces Day", startDate: "2026-10-08" }),
    holiday({ description: "Public holiday", id: "google-1", name: "Revolution Day", source: "google_calendar", startDate: "2026-07-23" }),
  ]);
  assert.equal(list.length, 2, "8 Oct is one row");
  const october = list.find((row) => row.startDate === "2026-10-08");
  assert.ok(october);
  assert.equal(october.name, "Armed Forces Day", "the Day-off twin collapses into the holiday name");
  assert.equal(october.description, null, "an administrator's confirmation note is never shown to employees");
  assert.equal(list[0].description, "Public holiday", "a calendar holiday keeps its own description");
}

function vacationReportWordsAndTheSlaCard() {
  assert.equal(vacationDaysLabel(1), "1 day");
  assert.equal(vacationDaysLabel(0.5), "0.5 days");
  assert.equal(vacationDaysLabel(3), "3 days");
  assert.equal(overlapWarningsLabel(1), "1 warning");
  assert.equal(overlapWarningsLabel(2), "2 warnings");

  assert.equal(showsDailySlaRunCard({ canAdminManage: true, isSelfView: false }), true, "HR and Super Admin keep the card");
  assert.equal(showsDailySlaRunCard({ canAdminManage: false, isSelfView: false }), false, "a manager never sees the background job card");
  assert.equal(showsDailySlaRunCard({ canAdminManage: true, isSelfView: true }), false, "nobody's own leave view shows it");

  const report = readFileSync(new URL("../src/components/vacation/vacation-report.tsx", import.meta.url), "utf8");
  assert.match(report, /showsDailySlaRunCard\(\{ canAdminManage, isSelfView \}\) \? \(/, "the card renders only behind the gate");
  assert.doesNotMatch(report, /Master Requests/, "the tab has a plain name");
}

function attendanceAnalyticsCardAgreesWithTheRows() {
  // 11 Oct 2026: 242 min late AND short, so the engine labelled it "Short day" and the card,
  // counting the "Late" status only, read 0 beside a row showing 242 min.
  const rows = [
    { earlyLeaveMinutes: "0", lateMinutes: "242", status: "Short day" },
    { earlyLeaveMinutes: "15", lateMinutes: "0", status: "Early leave" },
    { earlyLeaveMinutes: "0", lateMinutes: "0", status: "Complete" },
    { earlyLeaveMinutes: null, lateMinutes: "", status: "Single punch" },
  ];
  assert.equal(isLateOrEarlyDay(rows[0]), true, "a late day labelled Short day is still a late day");
  assert.equal(countLateOrEarlyDays(rows), 2);

  const service = readFileSync(new URL("../src/lib/attendance/employee-attendance.ts", import.meta.url), "utf8");
  assert.match(service, /summary\.lateOrEarlyDays = countLateOrEarlyDays\(rows\)/);
  for (const path of [
    "../src/components/employee-portal/fingerprint-analytics.tsx",
    "../src/components/employee-portal/attendance-overview.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /label="Late \/ early" value=\{summary\.lateOrEarlyDays \?\? summary\.lateDays\}/,
      `${path} shows the late-or-early count`,
    );
  }

  assert.equal(workedHoursLabel("08:14"), "8h14m");
  assert.equal(workedHoursLabel("10:05"), "10h05m");
  assert.equal(workedHoursLabel(""), "");

  // A per-person policy is stored as "Ali Elsayed (A-12)": the card names the person, never the HR id.
  assert.equal(
    explainerPolicyName({ policy_name: "Ali Elsayed (A-12)", target_type: "employee_hr_id" }, "Ali Mohamed"),
    "Personal policy for Ali Mohamed",
  );
  assert.equal(explainerPolicyName({ policy_name: "Ali Elsayed (A-12)", target_type: "employee_hr_id" }, null), "Your personal policy");
  assert.equal(explainerPolicyName({ policy_name: "Head Office", target_type: "department" }), "Head Office");
}

function workingDaysWithNoPunchReadNoRecord() {
  // Sun 4 to Sat 10 Oct 2026, today 9 Oct. Head-office week: Sunday to Thursday.
  const days = noRecordWorkingDays({
    dateFrom: "2026-10-04",
    dateTo: "2026-10-10",
    holidayDates: ["2026-10-06"],
    jobTitle: "National Sales Manager",
    recordedDates: ["2026-10-04"],
    todayIso: "2026-10-09",
    workingWeekdays: [0, 1, 2, 3, 4],
  });
  assert.deepEqual(days, ["2026-10-05", "2026-10-07", "2026-10-08"], "a recorded day, a holiday, the weekend and today onward are left out");

  const merged = mergeNoRecordDays([{ rawDate: "2026-10-08" }, { rawDate: "2026-10-04" }], ["2026-10-07", "2026-10-08", "2026-10-05"]);
  assert.deepEqual(
    merged.map((row) => row.rawDate),
    ["2026-10-08", "2026-10-07", "2026-10-05", "2026-10-04"],
    "newest first, no date doubled",
  );
}

export function runPortalLeaveAttendancePolishTests() {
  myClaimsCardAgreesWithTheRows();
  nationalHolidaysTabShowsOneRowAndNoOwnerNotes();
  vacationReportWordsAndTheSlaCard();
  attendanceAnalyticsCardAgreesWithTheRows();
  workingDaysWithNoPunchReadNoRecord();
}
