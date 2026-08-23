import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  attendanceDeviceUserKey,
  buildAttendanceReadinessMetrics,
  resolveActiveAttendancePolicy,
  resolveAttendanceStatus,
  resolveDeviceMappingStatus,
  resolvePolicyAttendanceStatus,
  summarizeAttendancePolicies,
  summarizeDeviceUserMappings,
  summarizeFingerprintDeductionQuantities,
  summarizeFingerprintRows,
} from "../src/lib/attendance/metrics.ts";
import {
  buildHrCalendarEvents,
  countHrWorkingDays,
  isHrWorkingDay,
} from "../src/lib/hr-calendar/calendar-logic.ts";
import {
  formatAttendanceWorkingWeekdays,
  isAttendanceScheduledWorkingDay,
  normalizeAttendanceWorkingWeekdays,
} from "../src/lib/attendance/work-schedule.ts";
import type { HrCalendarEmployee } from "../src/lib/hr-calendar/types.ts";

export function runAttendanceCalendarSourceTests() {
  assert.equal(attendanceDeviceUserKey("DEV1", "42"), "DEV1\u000042");
  assert.equal(resolveDeviceMappingStatus({ employeeHrId: null, isActive: true }), "unmapped");
  assert.equal(resolveDeviceMappingStatus({ employeeHrId: "E001", isActive: false }), "inactive");
  assert.equal(resolveDeviceMappingStatus({ employeeHrId: "E001", isActive: true }), "active");

  // A device user who is deliberately not an employee - a driver, guard or cleaner enrolled on
  // the reader - must read as its own status, never as "unmapped". Both carry a null HR_ID, but
  // only one of them is an unanswered question, and counting the answered one as missing is what
  // kept device user 18 in the unmapped panel for months.
  assert.equal(
    resolveDeviceMappingStatus({ employeeHrId: null, isActive: false, nonEmployeeLabel: "Driver" }),
    "non_employee",
  );
  // A blank or whitespace label is not an answer, so it must fall back to unmapped rather than
  // silently promoting an unknown id to "identified".
  assert.equal(
    resolveDeviceMappingStatus({ employeeHrId: null, isActive: false, nonEmployeeLabel: "   " }),
    "unmapped",
  );
  assert.equal(
    resolveDeviceMappingStatus({ employeeHrId: null, isActive: false, nonEmployeeLabel: null }),
    "unmapped",
  );
  // An employee always wins. The DB constraint makes this combination impossible, but the
  // resolver must not depend on the constraint being there.
  assert.equal(
    resolveDeviceMappingStatus({ employeeHrId: "E001", isActive: true, nonEmployeeLabel: "Driver" }),
    "active",
  );

  const mappingSummary = summarizeDeviceUserMappings([
    { employeeHrId: "E001", isActive: true },
    { employeeHrId: "E002", isActive: false },
    { employeeHrId: null, isActive: true },
  ]);
  assert.deepEqual(mappingSummary, {
    active: 1,
    inactive: 1,
    nonEmployee: 0,
    readinessRate: 2 / 3,
    total: 3,
    unmapped: 1,
  });

  // The headline: labelling one of two unknown ids must move it out of `unmapped` and lift
  // readiness, not merely rename it. 3 of 4 resolved, not 2 of 4.
  const nonEmployeeSummary = summarizeDeviceUserMappings([
    { employeeHrId: "E001", isActive: true },
    { employeeHrId: "E002", isActive: false },
    { employeeHrId: null, isActive: false, nonEmployeeLabel: "Driver" },
    { employeeHrId: null, isActive: false },
  ]);
  assert.deepEqual(nonEmployeeSummary, {
    active: 1,
    inactive: 1,
    nonEmployee: 1,
    readinessRate: 3 / 4,
    total: 4,
    unmapped: 1,
  });

  assert.deepEqual(resolveAttendanceStatus(1, 0), {
    deductionDays: "",
    deductionValue: "",
    recommendedAction: "Review missing punch",
    status: "Single punch",
  });
  assert.deepEqual(resolveAttendanceStatus(2, 7 * 60 * 60 * 1000), {
    deductionDays: "",
    deductionValue: "",
    recommendedAction: "Review short day",
    status: "Short day",
  });
  assert.deepEqual(resolveAttendanceStatus(2, 8 * 60 * 60 * 1000), {
    deductionDays: "0",
    deductionValue: "0",
    recommendedAction: "No action",
    status: "Complete",
  });
  const standardPolicy = {
    effective_from: "2026-01-01",
    effective_to: null,
    grace_minutes: 10,
    is_active: true,
    scheduled_end: "17:00",
    scheduled_start: "09:00",
    target_type: "default",
    target_value: null,
  };
  const lateRules = [
    {
      deduction_days: "0.25",
      deduction_value: null,
      event_type: "late",
      from_minutes: 16,
      is_active: true,
      recommended_action: "Deduct quarter day",
      sort_order: 1,
      to_minutes: 30,
    },
  ];
  assert.deepEqual(resolvePolicyAttendanceStatus({
    baseSalary: 15000,
    // 2026-03 has 31 days; the day rate divides by THAT month's actual calendar
    // days, so the fixture must name the day being charged.
    reportDate: "2026-03-10",
    durationMinutes: 470,
    firstPunchMinutes: 9 * 60,
    lastPunchMinutes: 16 * 60 + 50,
    policy: standardPolicy,
    rules: lateRules,
    visiblePunchCount: 2,
  }), {
    deductionDays: "0",
    deductionValue: "0",
    earlyLeaveMinutes: "",
    lateMinutes: "",
    recommendedAction: "No action",
    status: "Complete",
  });
  assert.deepEqual(resolvePolicyAttendanceStatus({
    baseSalary: 15000,
    // 2026-03 has 31 days; the day rate divides by THAT month's actual calendar
    // days, so the fixture must name the day being charged.
    reportDate: "2026-03-10",
    durationMinutes: 470,
    firstPunchMinutes: 9 * 60 + 10,
    lastPunchMinutes: 17 * 60,
    policy: standardPolicy,
    rules: lateRules,
    visiblePunchCount: 2,
  }), {
    deductionDays: "0",
    deductionValue: "0",
    earlyLeaveMinutes: "",
    lateMinutes: "",
    recommendedAction: "No action",
    status: "Complete",
  });
  assert.deepEqual(resolvePolicyAttendanceStatus({
    baseSalary: 15000,
    // 2026-03 has 31 days; the day rate divides by THAT month's actual calendar
    // days, so the fixture must name the day being charged.
    reportDate: "2026-03-10",
    durationMinutes: 460,
    firstPunchMinutes: 9 * 60 + 10,
    lastPunchMinutes: 16 * 60 + 50,
    policy: standardPolicy,
    rules: lateRules,
    visiblePunchCount: 2,
  }), {
    deductionDays: "0.25",
    // 15000 / 31 (March) * 0.25 = 120.97. This used to assert 125.00, which is
    // 15000 / 30 — the flat divisor this path used before it was routed to the
    // deductions implementation. The old number was pinning the defect: the owner's
    // standing rule is Base / ACTUAL calendar days, everywhere, and fingerprint was
    // the one category still on /30.
    deductionValue: "120.97",
    earlyLeaveMinutes: "",
    lateMinutes: "20",
    recommendedAction: "Deduct quarter day",
    status: "Late",
  });
  assert.deepEqual(resolvePolicyAttendanceStatus({
    baseSalary: 15000,
    // 2026-03 has 31 days; the day rate divides by THAT month's actual calendar
    // days, so the fixture must name the day being charged.
    reportDate: "2026-03-10",
    durationMinutes: 468,
    firstPunchMinutes: 9 * 60 + 12,
    lastPunchMinutes: 17 * 60,
    policy: standardPolicy,
    rules: lateRules,
    visiblePunchCount: 2,
  }), {
    deductionDays: "",
    deductionValue: "",
    earlyLeaveMinutes: "",
    lateMinutes: "12",
    recommendedAction: "Missing deduction rule: Review late arrival",
    status: "Late",
  });
  assert.deepEqual(summarizeFingerprintRows([
    { recommendedAction: "No action", status: "Complete" },
    { recommendedAction: "Review short day", status: "Short day" },
    { recommendedAction: "Review missing punch", status: "Single punch" },
  ]), {
    complete: 1,
    deductions: 2,
    rows: 3,
    shortDays: 1,
    singlePunches: 1,
  });

  assert.deepEqual(summarizeFingerprintDeductionQuantities([
    { deductionDays: "0.13" },
    { deductionDays: "0" },
    { deductionDays: 0.25 },
    { deductionDays: "Base salary missing" },
  ]), {
    deductionDays: 0.38,
    quantity: 2,
  });

  const selectedPolicy = resolveActiveAttendancePolicy(
    { hr_id: "e001", job_title: "Rep" },
    [
      { effective_from: "2026-01-01", effective_to: null, is_active: true, target_type: "default", target_value: null },
      { effective_from: "2026-01-01", effective_to: null, is_active: true, target_type: "job_title", target_value: "REP" },
      { effective_from: "2026-02-01", effective_to: null, is_active: true, target_type: "employee_hr_id", target_value: "E001" },
    ],
    "2026-05-01",
    "2026-05-31",
  );
  assert.equal(selectedPolicy?.target_type, "employee_hr_id");
  const allTimeA3Policy = resolveActiveAttendancePolicy(
    { hr_id: "A-3", job_title: "Office Admin" },
    [
      { effective_from: "2026-01-01", effective_to: null, is_active: true, target_type: "default", target_value: null },
      {
        effective_from: "1900-01-01",
        effective_to: null,
        is_active: true,
        target_type: "employee_hr_id",
        target_value: "A-3",
        working_weekdays: [1, 3],
      },
    ],
    "2026-05-01",
    "2026-05-31",
  );
  assert.deepEqual(allTimeA3Policy?.working_weekdays, [1, 3], "A-3 custom workdays must apply before June");
  assert.deepEqual(normalizeAttendanceWorkingWeekdays("{1,3}"), [1, 3]);
  assert.equal(formatAttendanceWorkingWeekdays([1, 3]), "Mon, Wed");
  assert.equal(isAttendanceScheduledWorkingDay({ dateIso: "2026-06-08", workingWeekdays: [1, 3] }), true);
  assert.equal(isAttendanceScheduledWorkingDay({ dateIso: "2026-06-09", workingWeekdays: [1, 3] }), false);
  assert.deepEqual(summarizeAttendancePolicies([
    { isActive: true, targetType: "default" },
    { isActive: true, targetType: "job_title" },
    { isActive: false, targetType: "employee_hr_id" },
  ]), {
    active: 2,
    defaultPolicies: 1,
    employeePolicies: 1,
    jobTitlePolicies: 1,
    total: 3,
  });
  assert.deepEqual(buildAttendanceReadinessMetrics({
    deviceMappings: [
      { employeeHrId: "E001", isActive: true },
      { employeeHrId: null, isActive: true },
    ],
    policies: [
      { isActive: true, targetType: "default" },
      { isActive: false, targetType: "job_title" },
    ],
  }), {
    activeMappings: 1,
    activePolicies: 1,
    mappingReadinessRate: 0.5,
    missingDeviceMappings: 1,
    policyCoverageRate: 0.5,
    totalDeviceMappings: 2,
    totalPolicies: 2,
  });

  const employees: HrCalendarEmployee[] = [
    {
      areaName: "Nasr City",
      birthDate: "1990-05-03",
      fullName: "A Employee",
      hireDate: "2025-05-02",
      hrId: "E001",
      jobTitle: "Rep",
      lineName: "Line A",
      managerName: "Manager",
      workEmail: null,
    },
    {
      areaName: "Nasr City",
      birthDate: "",
      fullName: "B Employee",
      hireDate: "2026-05-04",
      hrId: "E002",
      jobTitle: "Rep",
      lineName: "Line A",
      managerName: "Manager",
      workEmail: null,
    },
  ];
  const events = buildHrCalendarEvents(employees, 5, 2026);
  assert.deepEqual(events.map((event) => event.eventType), ["anniversary", "birthday", "new_hire"]);
  assert.equal(isHrWorkingDay(new Date(2026, 4, 3)), true);
  assert.equal(isHrWorkingDay(new Date(2026, 4, 1)), false);
  assert.equal(isHrWorkingDay(new Date(2026, 4, 2)), true);
  assert.equal(isHrWorkingDay(new Date(2026, 4, 3), ["2026-05-03"]), false);
  assert.equal(countHrWorkingDays("2026-05-03", "2026-05-07", ["2026-05-05"]), 4);
  assert.equal(
    countHrWorkingDays("2026-05-07", "2026-05-09", [], { friday: "full_day", saturday: "pm_only", thursday: "am_only" }),
    1,
  );

  const fingerprintSource = readFileSync("src/lib/attendance/fingerprint-report.ts", "utf8");
  assert.match(fingerprintSource, /resolvePolicyAttendanceStatus/);
  assert.match(fingerprintSource, /resolveActiveAttendancePolicy/);
  assert.match(fingerprintSource, /summarizeFingerprintRows/);
  assert.match(fingerprintSource, /workingDays/);
  assert.match(
    fingerprintSource,
    /loadApprovedHalfDayVacationMap/,
    "the report must look up approved half-day (Am\/Pm Only) vacations before judging short-day\/deduction status",
  );
  assert.match(
    fingerprintSource,
    /requiredMinutesForHalfDayVacation\(input\.policy\.required_minutes!, input\.halfDayVacationPart\)/,
    "the flexible-hours required-minutes window must be halved via the shared pure helper, not re-derived inline",
  );
  assert.match(
    fingerprintSource,
    /\.eq\("status", "approved"\)\s*\n\s*\.in\("day_part", \["am_only", "pm_only"\]\)/,
    "the half-day vacation lookup must only trust approved, explicitly half-day (not full-day) vacation rows",
  );
  assert.match(
    fingerprintSource,
    /halfDayVacationPart: halfDayVacationPart \?\? undefined,/,
    "the half-day vacation part must be threaded onto the report row so downstream consumers (the private calendar) can label it correctly instead of claiming a full day",
  );

  const mappingSource = readFileSync("src/lib/attendance/device-user-mapping.ts", "utf8");
  assert.match(mappingSource, /resolveDeviceMappingStatus/);
  assert.match(mappingSource, /summarizeDeviceUserMappings/);
  assert.match(mappingSource, /non_employee_label/, "the dashboard read must select the non-employee label or every labelled device user reverts to unmapped on screen");
  // The silent-erase guard. The bulk XLSX upload calls this service without knowing the column
  // exists; if the column were written unconditionally, every upload would wipe every label.
  assert.match(
    mappingSource,
    /nonEmployeeLabelProvided = input\.nonEmployeeLabel !== undefined/,
    "saveAttendanceDeviceUserMapping must distinguish an omitted non-employee label from an explicit null, and omit the column entirely when the caller did not supply it",
  );

  const nonEmployeeMigrationSource = readFileSync(
    "supabase/migrations/20260823170000_attendance_non_employee_device_users.sql",
    "utf8",
  );
  assert.match(
    nonEmployeeMigrationSource,
    /attendance_device_user_map_non_employee_exclusive/,
    "a non-employee label must be mutually exclusive with employee_hr_id at the database level, not only in the service",
  );
  assert.match(
    nonEmployeeMigrationSource,
    /is_active = false/,
    "a labelled non-employee must be pinned inactive so their punches are never ingested into payroll-bearing attendance",
  );

  const policySource = readFileSync("src/lib/attendance/policies.ts", "utf8");
  assert.match(policySource, /summarizeAttendancePolicies/);
  assert.match(policySource, /deleteAttendancePolicy/);
  assert.match(policySource, /"exception"/);
  assert.match(policySource, /validatePolicyRules/);
  assert.match(policySource, /workingWeekdays/);
  const policyManagerSource = readFileSync("src/components/attendance/attendance-policies-manager.tsx", "utf8");
  assert.match(policyManagerSource, /Add exception/);
  assert.match(policyManagerSource, /Delete rule/);
  assert.match(policyManagerSource, /Rule Preview/);
  assert.match(policyManagerSource, /Late brackets/);
  assert.match(policyManagerSource, /overlap/);
  assert.match(policyManagerSource, /Day fraction/);
  assert.match(policyManagerSource, /9-5 \+ 10 min grace/);
  assert.match(policyManagerSource, /scrollIntoView/);
  assert.match(policyManagerSource, /Custom Workdays/);
  assert.match(policyManagerSource, /Policy Priority/);
  assert.match(policyManagerSource, /Draft Snapshot/);
  assert.match(policyManagerSource, /Configured Policies/);
  const monthlySummarySource = readFileSync("src/components/attendance/monthly-attendance-summary.tsx", "utf8");
  const monthlySummaryExportSource = readFileSync("src/lib/attendance/monthly-summary-export.ts", "utf8");
  assert.match(monthlySummarySource, /attendanceMonthlyCycleNote/);
  assert.match(monthlySummaryExportSource, /attendanceMonthlyCycleNote/);

  const a3AllTimeMigrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260615082501_a3_office_calendar_all_time.sql", "utf8");
  assert.match(a3AllTimeMigrationSource, /date '1900-01-01'/, "A-3 custom office policy must be all-time, not June-only");

  const calendarPageSource = readFileSync("app/(admin)/hr-calendar/page.tsx", "utf8");
  assert.match(calendarPageSource, /getHrCalendarData/);
  const calendarComponentSource = readFileSync("src/components/hr-calendar/hr-calendar.tsx", "utf8");
  assert.match(calendarComponentSource, /buildHrCalendarEvents/);
  assert.match(calendarComponentSource, /buildHrCalendarDays/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /buildAttendanceReadinessMetrics/);
  assert.match(platformSource, /countHrWorkingDays/);
  assert.match(platformSource, /platformMetrics\.attendance|attendance,/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /platformMetrics\.attendance\.mappingReadinessRate/);
  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /platformMetrics\.attendance\.mappingReadinessRate/);
  const dataHealthSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.match(dataHealthSource, /summarizeDeviceUserMappings/);
  assert.match(
    dataHealthSource,
    /nonEmployeeLabel: rowText\(row, "non_employee_label"\)/,
    "the admin data-health tile must read the non-employee label too, or it keeps reporting identified drivers as missing device mappings",
  );
}
