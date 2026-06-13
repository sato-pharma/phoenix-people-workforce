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
  summarizeFingerprintRows,
} from "../src/lib/attendance/metrics.ts";
import {
  buildHrCalendarEvents,
  countHrWorkingDays,
  isHrWorkingDay,
} from "../src/lib/hr-calendar/calendar-logic.ts";
import type { HrCalendarEmployee } from "../src/lib/hr-calendar/types.ts";

export function runAttendanceCalendarSourceTests() {
  assert.equal(attendanceDeviceUserKey("DEV1", "42"), "DEV1\u000042");
  assert.equal(resolveDeviceMappingStatus({ employeeHrId: null, isActive: true }), "unmapped");
  assert.equal(resolveDeviceMappingStatus({ employeeHrId: "E001", isActive: false }), "inactive");
  assert.equal(resolveDeviceMappingStatus({ employeeHrId: "E001", isActive: true }), "active");

  const mappingSummary = summarizeDeviceUserMappings([
    { employeeHrId: "E001", isActive: true },
    { employeeHrId: "E002", isActive: false },
    { employeeHrId: null, isActive: true },
  ]);
  assert.deepEqual(mappingSummary, {
    active: 1,
    inactive: 1,
    readinessRate: 2 / 3,
    total: 3,
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
    durationMinutes: 460,
    firstPunchMinutes: 9 * 60 + 10,
    lastPunchMinutes: 16 * 60 + 50,
    policy: standardPolicy,
    rules: lateRules,
    visiblePunchCount: 2,
  }), {
    deductionDays: "0.25",
    deductionValue: "125.00",
    earlyLeaveMinutes: "",
    lateMinutes: "20",
    recommendedAction: "Deduct quarter day",
    status: "Late",
  });
  assert.deepEqual(resolvePolicyAttendanceStatus({
    baseSalary: 15000,
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

  const mappingSource = readFileSync("src/lib/attendance/device-user-mapping.ts", "utf8");
  assert.match(mappingSource, /resolveDeviceMappingStatus/);
  assert.match(mappingSource, /summarizeDeviceUserMappings/);

  const policySource = readFileSync("src/lib/attendance/policies.ts", "utf8");
  assert.match(policySource, /summarizeAttendancePolicies/);
  assert.match(policySource, /deleteAttendancePolicy/);
  assert.match(policySource, /"exception"/);
  assert.match(policySource, /validatePolicyRules/);
  const policyManagerSource = readFileSync("src/components/attendance/attendance-policies-manager.tsx", "utf8");
  assert.match(policyManagerSource, /Add exception/);
  assert.match(policyManagerSource, /Delete rule/);
  assert.match(policyManagerSource, /Rule Preview/);
  assert.match(policyManagerSource, /Late brackets/);
  assert.match(policyManagerSource, /overlap/);
  assert.match(policyManagerSource, /Day fraction/);
  assert.match(policyManagerSource, /9-5 \+ 10 min grace/);
  assert.match(policyManagerSource, /scrollIntoView/);
  assert.match(policyManagerSource, /Policy Priority/);
  assert.match(policyManagerSource, /Draft Snapshot/);
  assert.match(policyManagerSource, /Configured Policies/);

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
}
