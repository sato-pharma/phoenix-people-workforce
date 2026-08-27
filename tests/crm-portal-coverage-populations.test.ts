import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { buildManagerSummariesDetailed } from "../src/lib/double-visit-analytics/service.ts";
import {
  buildDoctorCoverageBoard,
  DOCTOR_COVERAGE_SCAN_MONTHS_BACK,
  type DoctorCoveragePlanInput,
  type DoctorCoverageVisitInput,
} from "../src/lib/crm/sfe-doctor-coverage.ts";
import { summarizeCheckins, summarizeVisits, type CheckinRow, type Employee360Window, type VisitRow } from "../src/lib/employee-360/service.ts";
import { buildPrivateCalendarWorkbook } from "../src/lib/private-calendar/export.ts";
import type { PrivateCalendarItem, PrivateCalendarWorkspace } from "../src/lib/private-calendar/logic.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * Every percentage on these CRM-fed portal surfaces is a ratio between two populations, and each
 * defect here was the same mistake: the numerator counted a wider population than the denominator
 * described, so the figure could exceed 100% and the "how many are missing" companion figure
 * collapsed to zero. Measured on production before the fix: 11 of 19 hierarchy managers had a DV
 * Coverage above 100% (top: 225%), and 6 of 92 reps had a check-in Coverage above 100% (top: 150%).
 */

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function employee(input: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    areaName: null,
    crmId: null,
    departmentName: null,
    displayName: input.displayName ?? input.fullName ?? "Employee",
    employmentStatus: "active",
    fullName: input.fullName ?? "Employee",
    hrId: input.hrId ?? "E-1",
    jobTitle: input.jobTitle ?? "Medical Representative",
    lineName: null,
    managerHrId: null,
    managerName: null,
    positionTitle: input.positionTitle ?? "Medical Representative",
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

type DvRows = Parameters<typeof buildManagerSummariesDetailed>[0];

function dvRow(input: { date: string; dvHrId: string; visitedHrId: string }): Record<string, unknown> {
  return {
    activity_date: input.date,
    area_name: null,
    double_visitor_hr_id: input.dvHrId,
    double_visitor_name: null,
    id: `${input.dvHrId}-${input.date}-${input.visitedHrId}`,
    line_name: null,
    period: "PM",
    visit_type: null,
    visit_type_description: null,
    source_record_id: null,
    source_type: "ireports360",
    visit_count: 1,
    visited_employee_hr_id: input.visitedHrId,
    visited_employee_name: null,
    visited_employee_status: "active_mapped",
  };
}

let nextDoctorVisitId = 1;

function doctorVisit(overrides: Partial<DoctorCoverageVisitInput> = {}): DoctorCoverageVisitInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    agent_name: "Rep One",
    contact_crm_id: 500,
    contact_name: "Dr. In Window",
    crm_contact_grade: "B",
    crm_save_date: null,
    crm_visit_id: nextDoctorVisitId++,
    double_crm_id: null,
    speciality: "Pediatrics",
    visit_date: "2026-07-10",
    visit_type: 0,
    ...overrides,
  };
}

/** One assigned-list entry, matching the doctorVisit defaults so the two mirrors join. */
function plan(overrides: Partial<DoctorCoveragePlanInput> = {}): DoctorCoveragePlanInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    contact_crm_id: 500,
    contact_grade: "A",
    contact_name: "Dr. Pre Window",
    plan_date: "2026-08-03",
    speciality: "Pediatrics",
    ...overrides,
  };
}

function visitRow(visitDate: string): VisitRow {
  return {
    ampm: "AM",
    comment: null,
    contact_crm_id: 1,
    contact_name: "Dr. One",
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    visit_date: visitDate,
    visit_type: 0,
    visit_type_description: "Regular",
  };
}

function checkinRow(day: string): CheckinRow {
  return { check_date: `${day}T09:30:00+00:00`, lat: 30.1, lon: 31.2 };
}

/** Source-contract guards must read the CODE. The comments explaining each of these fixes quote the
 * very strings being banned, so an unfiltered read would match its own rationale. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

export async function runCrmPortalCoveragePopulationsTests() {
  // ── (A) DV manager Coverage % counts only the manager's OWN team ───────────────────────────────
  {
    const employees = [
      employee({ fullName: "Own DSM", hrId: "B-10", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
      employee({ fullName: "MR 1", hrId: "M-1", managerHrId: "B-10" }),
      employee({ fullName: "MR 2", hrId: "M-2", managerHrId: "B-10" }),
      employee({ fullName: "MR 3", hrId: "M-3", managerHrId: "B-10" }),
      employee({ fullName: "MR 4", hrId: "M-4", managerHrId: "B-10" }),
      employee({ fullName: "MR 5", hrId: "M-5", managerHrId: "B-10" }),
      employee({ employmentStatus: "resigned", fullName: "MR 6 (left)", hrId: "M-6", managerHrId: "B-10" }),
      employee({ fullName: "Other DSM", hrId: "B-20", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
      employee({ fullName: "Foreign MR 1", hrId: "F-1", managerHrId: "B-20" }),
      employee({ fullName: "Foreign MR 2", hrId: "F-2", managerHrId: "B-20" }),
      employee({ fullName: "Foreign MR 3", hrId: "F-3", managerHrId: "B-20" }),
    ];
    // Two of his own five, plus three reps from the other district and one who has left.
    const rows = [
      dvRow({ date: "2026-06-01", dvHrId: "B-10", visitedHrId: "M-1" }),
      dvRow({ date: "2026-06-02", dvHrId: "B-10", visitedHrId: "M-2" }),
      dvRow({ date: "2026-06-03", dvHrId: "B-10", visitedHrId: "M-6" }),
      dvRow({ date: "2026-06-04", dvHrId: "B-10", visitedHrId: "F-1" }),
      dvRow({ date: "2026-06-05", dvHrId: "B-10", visitedHrId: "F-2" }),
      dvRow({ date: "2026-06-06", dvHrId: "B-10", visitedHrId: "F-3" }),
    ] as unknown as DvRows;

    const { summaries } = buildManagerSummariesDetailed(rows, employees, "2026-06-30");
    const dsm = summaries.find((summary) => summary.managerName === "Own DSM");
    assert.ok(dsm, "the DSM must appear in the manager summaries");
    assert.equal(dsm!.teamMrCount, 5, "the denominator is the manager's active team MRs — the resigned rep is not one");
    assert.equal(
      dsm!.distinctMrs,
      6,
      "the personal-effort lens still reports every MR he rode along with, in or out of his team",
    );
    assert.equal(
      dsm!.coveragePct,
      40,
      "Coverage is 2 of his own 5 team MRs — counting the 3 foreign reps and the leaver would read 120% for a manager who skipped 3 of his own people",
    );
    assert.equal(
      dsm!.neglectedMrCount,
      3,
      "the 3 team MRs he never visited must be reported as neglected, not hidden by an over-100% numerator",
    );
    assert.ok(
      (dsm!.coveragePct ?? 0) <= 100,
      "coverage of a population by a subset of itself can never exceed 100%",
    );
  }

  // ── (B) Every trend point is scored against THAT month's own list ─────────────
  //
  // Re-using the selected month's list across the window would invent history. Assigned lists move
  // every month — production ranges 8,749 to 9,376 distinct (rep, doctor) pairs a month over
  // 2026-05..2026-08 — so a doctor added in August would read as neglected all summer, and one
  // dropped in June would keep scoring his old rep forever.
  //
  // The widened scan (2 months past the oldest trend month) survives the change of denominator. It
  // no longer decides MEMBERSHIP — the list does that — but it is still the only source of a
  // doctor's grade, name and last-seen date when the trend window itself holds no visit for him,
  // and the call list ranks on exactly that date.
  {
    assert.equal(
      DOCTOR_COVERAGE_SCAN_MONTHS_BACK,
      5,
      "the visit scan must reach 2 months past the oldest trend month, or a doctor last seen before the chart starts has no last-visit date at all",
    );

    // Selected month 2026-08 → trend 2026-05..2026-08; visits scanned back to 2026-03.
    const board = buildDoctorCoverageBoard(
      [
        // Doctor 500: last seen 2026-04, BEFORE the chart starts, then again in July.
        doctorVisit({ contact_name: "Dr. Pre Window", visit_date: "2026-04-10" }),
        doctorVisit({ visit_date: "2026-07-10" }),
        // Doctor 501: visited in May itself. B-grade needs one visit, so May is green for him.
        doctorVisit({ contact_crm_id: 501, contact_name: "Dr. In May", visit_date: "2026-05-12" }),
        // Doctor 502: seen in April and never again. His grade exists ONLY on that pre-window row.
        doctorVisit({
          contact_crm_id: 502,
          contact_name: "Dr. Gone Since April",
          crm_contact_grade: "C",
          visit_date: "2026-04-20",
        }),
      ],
      "2026-08",
      {
        planRows: [
          // May's list: three doctors, one of whom (501) was visited that month.
          plan({ contact_crm_id: 500, plan_date: "2026-05-04" }),
          plan({ contact_crm_id: 501, contact_grade: "B", plan_date: "2026-05-04" }),
          // 502 is on May's list but carries no grade on the list row, so the pre-window April
          // visit is the only place his grade exists. Losing it drops him out of May's denominator
          // — the same shape of error that once hid 1,317 of 1,848 doctors from the oldest month.
          plan({ contact_crm_id: 502, contact_grade: null, plan_date: "2026-05-04" }),
          // August's list is DIFFERENT: 502 has been taken off it, and he must not be scored in
          // August because of a row that only ever described May.
          plan({ contact_crm_id: 500, plan_date: "2026-08-03" }),
          plan({ contact_crm_id: 501, contact_grade: "B", plan_date: "2026-08-03" }),
        ],
      },
    );

    const oldest = board.trend[0];
    assert.equal(oldest?.month, "2026-05", "the trend still starts 3 months before the selected month");
    assert.equal(
      oldest?.activePanel,
      3,
      "May is scored against MAY's list of three — including the doctor who is gradeable only from a visit made before the chart starts",
    );
    assert.equal(
      oldest?.coveragePct,
      33,
      "1 of the 3 doctors assigned in May was visited in May",
    );

    const selected = board.trend[board.trend.length - 1];
    assert.equal(selected?.month, "2026-08");
    assert.equal(
      selected?.activePanel,
      2,
      "August is scored against AUGUST's list — a doctor taken off the list is off the denominator, not a permanent red",
    );
    assert.equal(
      selected?.activePanel,
      board.totals.activePanel,
      "the selected month's trend point and the headline tiles must be one number, computed once",
    );
    assert.equal(
      board.doctors.find((doctor) => doctor.contactCrmId === 502),
      undefined,
      "a doctor on May's list but not August's counts in May's denominator and must never appear on August's board",
    );

    // The pre-window months exist to answer "when was he last seen" and to fill a grade or name the
    // window itself never carried. They must not decide anything else, or the board silently
    // reports on visits it never displays.
    const preWindowDoctor = board.doctors.find((doctor) => doctor.contactCrmId === 500);
    assert.ok(preWindowDoctor, "the doctor seen in July is still on the selected month's board");
    assert.equal(preWindowDoctor!.gradeTier, "A", "the grade on the assignment wins over any grade seen on a visit");
    assert.equal(preWindowDoctor!.contactName, "Dr. Pre Window", "the name on the assignment is what the row displays");
    assert.equal(preWindowDoctor!.repKey, "hr:m-1", "the doctor belongs to the rep he was ASSIGNED to");
    assert.equal(
      preWindowDoctor!.lastVisitDate,
      "2026-07-10",
      "the last-seen date is the newest visit anywhere in the scan — it is what the call list ranks on",
    );
    assert.equal(preWindowDoctor!.status, "red", "assigned in August, not visited in August");
  }

  // ── (D) A multi-day item occupies every day it covers in the exported sheet ────────────────────
  {
    const vacation: PrivateCalendarItem = {
      approvalImpact: null,
      description: "Approved annual vacation.",
      detailLines: [],
      employeeDepartmentName: null,
      employeeHrId: "E-1",
      employeeJobTitle: null,
      employeeLineName: null,
      employeeName: "Employee One",
      endDate: "2026-06-18",
      exceptionFlags: [],
      id: "vacation-1",
      managerName: null,
      severity: "success",
      source: "vacation",
      sourceLabel: "Vacation",
      sourceRecordId: "vacation-1",
      sourceSystem: "Vacation",
      sourceTable: "v2_vacation_requests",
      startDate: "2026-06-15",
      status: "Approved",
      time: "Full day",
      title: "Annual Vacation",
    };
    const june = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      inMonth: true,
    }));
    const workspace = {
      access: { canSelectEmployee: false, isGlobalViewer: false },
      exceptions: [],
      items: [vacation],
      month: 6,
      schemaReady: true,
      selectedEmployee: {
        departmentName: null,
        fullName: "Employee One",
        hrId: "E-1",
        jobTitle: "Medical Rep",
        lineName: null,
        managerHrId: null,
        managerName: null,
      },
      sourceReadiness: {},
      summary: { attendance: 0, double_visit: 0, excuse: 0, field_visit: 0, holiday: 0, total: 1, vacation: 1 },
      teamSummary: [],
      viewMode: "self",
      visibleEmployees: [],
      weeks: [june],
      year: 2026,
    } as unknown as PrivateCalendarWorkspace;

    const buffer = await buildPrivateCalendarWorkbook(workspace, new Date("2026-07-01T08:00:00Z"));
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as unknown as Parameters<typeof reloaded.xlsx.load>[0]);
    const sheet = reloaded.getWorksheet("Calendar");
    assert.ok(sheet, "the workbook must carry the Calendar sheet");

    const ACTIVITY_COLUMN = 4; // Date · Day · Source · Activity — single-employee export
    const DATE_COLUMN = 1;
    const FIRST_DATA_ROW = 4; // brand band, stamp, header
    const vacationRows: Array<{ date: string; row: number }> = [];
    sheet!.eachRow((row, rowNumber) => {
      if (rowNumber < FIRST_DATA_ROW) return;
      if (String(row.getCell(ACTIVITY_COLUMN).value ?? "") === "Annual Vacation") {
        vacationRows.push({ date: String(row.getCell(DATE_COLUMN).value ?? ""), row: rowNumber });
      }
    });
    assert.deepEqual(
      vacationRows.map((entry) => entry.row - FIRST_DATA_ROW + 1),
      [15, 16, 17, 18],
      "a 15th-to-18th vacation must occupy all four days — matching on the start date alone left 16th-18th reading '-', i.e. nothing to report, in the sheet HR keeps",
    );
    // Day-number check only: the date cell is Intl-formatted, and its field order varies with the
    // ICU build, so pinning the whole string would fail on a different runtime rather than a bug.
    assert.ok(
      vacationRows.every((entry, index) => entry.date.includes(String(15 + index))),
      "each of the four rows must be dated the day it represents",
    );
  }

  // ── (E) Check-in coverage counts corroborated ACTIVE days, not every GPS day ───────────────────
  {
    const window: Employee360Window = { from: "2026-06-01", label: "June 2026", to: "2026-06-30" };
    const visits = [visitRow("2026-06-01"), visitRow("2026-06-02"), visitRow("2026-06-03")];
    const checkins = [
      checkinRow("2026-06-01"), // the only day that is BOTH active and GPS-logged
      checkinRow("2026-06-10"),
      checkinRow("2026-06-11"),
      checkinRow("2026-06-12"),
      checkinRow("2026-06-15"),
    ];
    const visitSummary = summarizeVisits(visits, window);
    const checkinSummary = summarizeCheckins(checkins, visits, visitSummary);

    assert.equal(visitSummary.activeDays, 3, "active days are the days carrying a productive visit");
    assert.equal(checkinSummary.distinctCheckinDays, 5, "the raw GPS day count is unchanged and still reported");
    assert.ok(
      Math.abs((checkinSummary.checkinCoverage ?? 0) - 1 / 3) < 1e-9,
      "coverage is the 1 corroborated active day over 3 active days — dividing all 5 GPS days by 3 active days reads 167%",
    );
    assert.ok(
      (checkinSummary.checkinCoverage ?? 0) <= 1,
      "a share of active days can never exceed 100%, whatever the GPS log contains",
    );
    assert.equal(
      checkinSummary.uncorroboratedDays,
      2,
      "corroborated and uncorroborated active days must together account for every active day",
    );
    const june = checkinSummary.coverageTrend.find((point) => point.month === "2026-06");
    assert.ok(
      june && Math.abs((june.coverage ?? 0) - 1 / 3) < 1e-9,
      "the monthly trend uses the same two populations as the headline figure",
    );
  }

  // ── (C) The field-visit chip names the CRM contact, and never invents "Unnamed" ────────────────
  // Supabase-backed (scanVisitsForRange), so the column choice is pinned by source inspection.
  {
    const fieldVisits = codeOf("src/lib/private-calendar/field-visits.ts");
    assert.match(
      fieldVisits,
      /"visit_date,agent_hr_id,agent_name,agent_crm_id,contact_name,/,
      "the chip must read contact_name — customer_name is empty on 100% of production visit rows",
    );
    assert.match(
      fieldVisits,
      /collapseDuplicateVisitSubmissions\(/,
      "the chip's visit count must go through the canonical collapse, or a re-save reads as an extra visit here only",
    );
    assert.doesNotMatch(
      fieldVisits,
      /customer_name/,
      "customer_name must not come back at all; selecting it is what produced 'Unnamed customers' on every chip",
    );
    assert.doesNotMatch(
      fieldVisits,
      /Unnamed/,
      "a day the CRM does not name must fall back to the visit count, never to a placeholder word",
    );
    assert.match(
      fieldVisits,
      /existing\.visits \+= 1/,
      "the chip's count must count VISITS; counting the name set showed '? field visits' once every name turned out to be blank",
    );
  }

  // ── (F) "My Visits" and "Double Visits" collapse duplicates through the same door ──────────────
  {
    const myVisits = codeOf("src/lib/employee-portal/my-crm-visits.ts");
    const start = myVisits.indexOf("export async function fetchMyVisits(");
    assert.ok(start > 0, "fetchMyVisits must still exist");
    const body = myVisits.slice(start, myVisits.indexOf("export async function fetchTeamVisits("));
    assert.match(
      body,
      /collapseDoubleVisits: true/,
      "fetchMyVisits must reuse the canonical read-door collapse, or its tab disagrees with the Double Visits tab beside it",
    );
    assert.doesNotMatch(
      myVisits,
      /collapseDuplicateVisitSubmissions/,
      "the portal must never re-implement the collapse — it consumes the one in crm/reads.ts through the door flag",
    );
  }
}
