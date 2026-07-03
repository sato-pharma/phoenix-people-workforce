import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions-governance/calculations.ts";

export const standardAttendanceDayMs = 8 * 60 * 60 * 1000;

export type AttendanceDeviceMappingStatus = "active" | "inactive" | "unmapped";

export type AttendanceDeviceMappingMetricInput = {
  employeeHrId: string | null;
  isActive: boolean;
  status?: AttendanceDeviceMappingStatus;
};

export type AttendancePolicyMetricInput = {
  isActive: boolean;
  targetType: string | null;
};

export type AttendancePolicySelectionInput = {
  effective_from: string;
  effective_to: string | null;
  grace_minutes?: number | null;
  is_active: boolean | null;
  scheduled_end?: string | null;
  scheduled_start?: string | null;
  target_type: string | null;
  target_value: string | null;
  working_weekdays?: number[] | null;
};

export type AttendancePolicyRuleSelectionInput = {
  deduction_days: number | string | null;
  deduction_value?: number | string | null;
  event_type: string | null;
  from_minutes: number | null;
  is_active: boolean | null;
  recommended_action: string | null;
  sort_order?: number | null;
  to_minutes: number | null;
};

export type AttendancePolicyEmployeeInput = {
  hr_id: string | null;
  job_title: string | null;
};

export type FingerprintSummaryInput = {
  recommendedAction: string;
  status: string;
};

export type PolicyAttendanceStatusInput = {
  baseSalary?: number | null;
  durationMinutes: number;
  firstPunchMinutes: number | null;
  lastPunchMinutes: number | null;
  policy: AttendancePolicySelectionInput | null | undefined;
  rules: AttendancePolicyRuleSelectionInput[];
  visiblePunchCount: number;
};

export type PolicyAttendanceStatusResult = {
  deductionDays: string;
  deductionValue: string;
  earlyLeaveMinutes: string;
  lateMinutes: string;
  recommendedAction: string;
  status: string;
};

export function normalizeAttendanceHrId(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function attendanceDeviceUserKey(deviceId: string, deviceUserId: string) {
  return `${deviceId}\u0000${deviceUserId}`;
}

export function resolveDeviceMappingStatus(
  row: Pick<AttendanceDeviceMappingMetricInput, "employeeHrId" | "isActive">,
): AttendanceDeviceMappingStatus {
  if (!row.employeeHrId) return "unmapped";
  return row.isActive ? "active" : "inactive";
}

export function summarizeDeviceUserMappings(rows: AttendanceDeviceMappingMetricInput[]) {
  const summary = {
    active: 0,
    inactive: 0,
    readinessRate: 1,
    total: rows.length,
    unmapped: 0,
  };

  for (const row of rows) {
    const status = row.status ?? resolveDeviceMappingStatus(row);
    if (status === "active") summary.active += 1;
    else if (status === "inactive") summary.inactive += 1;
    else summary.unmapped += 1;
  }

  summary.readinessRate = summary.total > 0 ? (summary.total - summary.unmapped) / summary.total : 1;
  return summary;
}

export function resolveAttendanceStatus(visiblePunchCount: number, durationMs: number) {
  if (visiblePunchCount <= 1) {
    return {
      deductionDays: "",
      deductionValue: "",
      recommendedAction: "Review missing punch",
      status: "Single punch",
    };
  }

  if (durationMs < standardAttendanceDayMs) {
    return {
      deductionDays: "",
      deductionValue: "",
      recommendedAction: "Review short day",
      status: "Short day",
    };
  }

  return {
    deductionDays: "0",
    deductionValue: "0",
    recommendedAction: "No action",
    status: "Complete",
  };
}

function timeToMinutes(value: string | null | undefined) {
  const [hourText, minuteText] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function boundedInteger(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function scheduleDurationMinutes(policy: AttendancePolicySelectionInput | null | undefined) {
  const start = timeToMinutes(policy?.scheduled_start);
  const end = timeToMinutes(policy?.scheduled_end);
  if (start == null || end == null) return standardAttendanceDayMs / 60000;
  return end >= start ? end - start : end + 1440 - start;
}

function numberText(value: number | string | null | undefined) {
  if (value == null) return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

function findAttendanceRule(
  rules: AttendancePolicyRuleSelectionInput[],
  eventType: string,
  minutes: number | null,
) {
  return rules
    .filter((rule) => rule.is_active !== false)
    .filter((rule) => rule.event_type === eventType)
    .filter((rule) => {
      if (minutes == null) return true;
      const from = rule.from_minutes;
      const to = rule.to_minutes;
      return (from == null || minutes >= from) && (to == null || minutes <= to);
    })
    .sort((left, right) => Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0))[0];
}

function deductionAmountText(baseSalary: number | null | undefined, deductionDays: string) {
  if (!deductionDays.trim()) return "";
  const salary = Number(baseSalary);
  const days = Number(deductionDays);
  if (!Number.isFinite(days) || days <= 0) return days === 0 ? "0" : "";
  if (!Number.isFinite(salary) || salary <= 0) return "Base salary missing";
  const amount = calculateDeductionAmountFromBaseSalary({ baseSalary: salary, deductionDays: days });
  return amount != null ? amount.toFixed(2) : "Base salary missing";
}

function ruleStatusResult(input: {
  baseSalary?: number | null;
  defaultAction: string;
  earlyLeaveMinutes?: number;
  eventType: "early_leave" | "late" | "single_punch";
  lateMinutes?: number;
  minutes: number | null;
  rules: AttendancePolicyRuleSelectionInput[];
  status: string;
}): PolicyAttendanceStatusResult {
  const rule = findAttendanceRule(input.rules, input.eventType, input.minutes);
  const deductionDays = numberText(rule?.deduction_days);
  const missingRuleAction = input.eventType === "single_punch"
    ? input.defaultAction
    : `Missing deduction rule: ${input.defaultAction}`;
  return {
    deductionDays,
    deductionValue: deductionAmountText(input.baseSalary, deductionDays),
    earlyLeaveMinutes: input.earlyLeaveMinutes ? String(input.earlyLeaveMinutes) : "",
    lateMinutes: input.lateMinutes ? String(input.lateMinutes) : "",
    recommendedAction: rule?.recommended_action?.trim() || missingRuleAction,
    status: input.status,
  };
}

export function resolvePolicyAttendanceStatus(input: PolicyAttendanceStatusInput): PolicyAttendanceStatusResult {
  if (input.visiblePunchCount <= 1) {
    return ruleStatusResult({
      baseSalary: input.baseSalary,
      defaultAction: "Review missing punch",
      eventType: "single_punch",
      minutes: null,
      rules: input.rules,
      status: "Single punch",
    });
  }

  const policy = input.policy;
  if (!policy) {
    const fallback = resolveAttendanceStatus(input.visiblePunchCount, input.durationMinutes * 60000);
    return { ...fallback, earlyLeaveMinutes: "", lateMinutes: "" };
  }

  const scheduledStart = timeToMinutes(policy.scheduled_start);
  const scheduledEnd = timeToMinutes(policy.scheduled_end);
  if (scheduledStart == null || scheduledEnd == null || input.firstPunchMinutes == null || input.lastPunchMinutes == null) {
    const fallback = resolveAttendanceStatus(input.visiblePunchCount, input.durationMinutes * 60000);
    return { ...fallback, earlyLeaveMinutes: "", lateMinutes: "" };
  }

  const graceMinutes = boundedInteger(policy.grace_minutes ?? null, 0);
  const scheduledWorkMinutes = scheduleDurationMinutes(policy);
  const normalizedScheduledEnd = scheduledEnd >= scheduledStart ? scheduledEnd : scheduledEnd + 1440;
  const firstPunchMinutes = input.firstPunchMinutes;
  const lastPunchMinutes = input.lastPunchMinutes >= firstPunchMinutes
    ? input.lastPunchMinutes
    : input.lastPunchMinutes + 1440;
  const durationMinutes = Math.max(0, Math.floor(input.durationMinutes));
  const lateFromSchedule = Math.max(0, firstPunchMinutes - scheduledStart);
  const earlyLeaveMinutes = Math.max(0, normalizedScheduledEnd - lastPunchMinutes);
  const shortMinutes = Math.max(0, Math.ceil(scheduledWorkMinutes - durationMinutes));
  const dailyGraceUsageMinutes = Math.max(shortMinutes, lateFromSchedule + earlyLeaveMinutes);

  if (dailyGraceUsageMinutes <= graceMinutes) {
    return {
      deductionDays: "0",
      deductionValue: "0",
      earlyLeaveMinutes: "",
      lateMinutes: "",
      recommendedAction: "No action",
      status: "Complete",
    };
  }

  if (lateFromSchedule > 0) {
    return ruleStatusResult({
      baseSalary: input.baseSalary,
      defaultAction: "Review late arrival",
      eventType: "late",
      lateMinutes: dailyGraceUsageMinutes,
      minutes: dailyGraceUsageMinutes,
      rules: input.rules,
      status: "Late",
    });
  }

  return ruleStatusResult({
    baseSalary: input.baseSalary,
    defaultAction: earlyLeaveMinutes > 0 ? "Review early leave" : "Review short day",
    earlyLeaveMinutes: dailyGraceUsageMinutes,
    eventType: "early_leave",
    minutes: dailyGraceUsageMinutes,
    rules: input.rules,
    status: earlyLeaveMinutes > 0 ? "Early leave" : "Short day",
  });
}

export function summarizeFingerprintRows(rows: FingerprintSummaryInput[]) {
  return {
    complete: rows.filter((row) => row.status === "Complete").length,
    deductions: rows.filter((row) => row.recommendedAction !== "No action").length,
    rows: rows.length,
    shortDays: rows.filter((row) => row.status === "Short day").length,
    singlePunches: rows.filter((row) => row.status === "Single punch").length,
  };
}

export function rankAttendancePolicyTarget(targetType: string | null | undefined) {
  if (targetType === "employee_hr_id") return 3;
  if (targetType === "job_title") return 2;
  if (targetType === "default") return 1;
  return 0;
}

export function attendancePolicyMatchesEmployee(
  policy: Pick<AttendancePolicySelectionInput, "target_type" | "target_value">,
  employee: AttendancePolicyEmployeeInput,
) {
  const targetType = String(policy.target_type ?? "");
  const targetValue = String(policy.target_value ?? "").trim().toUpperCase();
  if (targetType === "employee_hr_id") return targetValue === normalizeAttendanceHrId(employee.hr_id);
  if (targetType === "job_title") return targetValue === String(employee.job_title ?? "").trim().toUpperCase();
  return targetType === "default";
}

export function resolveActiveAttendancePolicy<TPolicy extends AttendancePolicySelectionInput>(
  employee: AttendancePolicyEmployeeInput,
  policies: TPolicy[],
  dateFrom: string,
  dateTo: string,
) {
  return policies
    .filter((policy) => policy.is_active !== false)
    .filter((policy) => attendancePolicyMatchesEmployee(policy, employee))
    .filter((policy) => {
      const effectiveFrom = policy.effective_from || "1900-01-01";
      const effectiveTo = policy.effective_to || "9999-12-31";
      return effectiveFrom <= dateTo && effectiveTo >= dateFrom;
    })
    .sort((left, right) => {
      const rankDiff = rankAttendancePolicyTarget(right.target_type) - rankAttendancePolicyTarget(left.target_type);
      if (rankDiff !== 0) return rankDiff;
      return String(right.effective_from ?? "").localeCompare(String(left.effective_from ?? ""));
    })[0];
}

export function summarizeAttendancePolicies(policies: AttendancePolicyMetricInput[]) {
  return {
    active: policies.filter((policy) => policy.isActive).length,
    defaultPolicies: policies.filter((policy) => policy.targetType === "default").length,
    employeePolicies: policies.filter((policy) => policy.targetType === "employee_hr_id").length,
    jobTitlePolicies: policies.filter((policy) => policy.targetType === "job_title").length,
    total: policies.length,
  };
}

export function buildAttendanceReadinessMetrics(input: {
  deviceMappings: AttendanceDeviceMappingMetricInput[];
  policies: AttendancePolicyMetricInput[];
}) {
  const mappings = summarizeDeviceUserMappings(input.deviceMappings);
  const policies = summarizeAttendancePolicies(input.policies);

  return {
    activeMappings: mappings.active,
    activePolicies: policies.active,
    mappingReadinessRate: mappings.readinessRate,
    missingDeviceMappings: mappings.unmapped,
    policyCoverageRate: policies.total > 0 ? policies.active / policies.total : 1,
    totalDeviceMappings: mappings.total,
    totalPolicies: policies.total,
  };
}
