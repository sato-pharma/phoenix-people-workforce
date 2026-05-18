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
  is_active: boolean | null;
  target_type: string | null;
  target_value: string | null;
};

export type AttendancePolicyEmployeeInput = {
  hr_id: string | null;
  job_title: string | null;
};

export type FingerprintSummaryInput = {
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
