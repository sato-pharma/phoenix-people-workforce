import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { loadAttendanceFlexPolicyGroups } from "@/lib/attendance/policy-groups";
import { normalizeAttendanceHrId, summarizeAttendancePolicies } from "@/lib/attendance/metrics";
import {
  normalizeAttendanceWorkingWeekdays,
  type AttendanceWorkingWeekday,
} from "@/lib/attendance/work-schedule";
import { isAttendanceTracked } from "@/lib/attendance/eligibility";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";

export type AttendancePolicyTargetType = "default" | "employee_hr_id" | "job_title";
export type AttendancePolicyEventType = "absence" | "early_leave" | "exception" | "late" | "single_punch";

export type AttendancePolicyRule = {
  deductionDays: string;
  deductionValue: string;
  eventType: AttendancePolicyEventType;
  fromMinutes: string;
  id: number;
  isActive: boolean;
  recommendedAction: string;
  sortOrder: number;
  toMinutes: string;
};

export type AttendanceJudgmentMode = "every_working_day" | "office_days_only";

export type AttendancePolicyGroup = {
  effectiveFrom: string;
  effectiveTo: string;
  graceMinutes: number;
  id: number;
  isActive: boolean;
  policyName: string;
  rules: AttendancePolicyRule[];
  scheduledEnd: string;
  scheduledStart: string;
  targetType: AttendancePolicyTargetType;
  targetValue: string;
  workingWeekdays: AttendanceWorkingWeekday[];
  /** Flexible-hours weekly-digest fields (migration 20260703180000). Null = not yet migrated. */
  flexMinutes: number | null;
  requiredMinutes: number | null;
  halfDaySplitMinutes: number;
  judgmentMode: AttendanceJudgmentMode;
};

export type AttendancePolicyDashboard = {
  employees: Array<{ fullName: string; hrId: string }>;
  jobTitles: string[];
  policies: AttendancePolicyGroup[];
  summary: {
    active: number;
    defaultPolicies: number;
    employeePolicies: number;
    jobTitlePolicies: number;
    total: number;
  };
};

type PolicyDbRow = {
  effective_from: string;
  effective_to: string | null;
  grace_minutes: number;
  id: number;
  is_active: boolean;
  policy_name: string;
  scheduled_end: string;
  scheduled_start: string;
  target_type: AttendancePolicyTargetType;
  target_value: string | null;
  flex_minutes: number | null;
  required_minutes: number | null;
  half_day_split_minutes: number;
  judgment_mode: AttendanceJudgmentMode;
  working_weekdays: AttendanceWorkingWeekday[] | null;
};

type RuleDbRow = {
  deduction_days: number | string | null;
  deduction_value: number | string | null;
  event_type: AttendancePolicyEventType;
  from_minutes: number | null;
  id: number;
  is_active: boolean;
  policy_id: number;
  recommended_action: string;
  sort_order: number;
  to_minutes: number | null;
};

function cleanText(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function nullableText(value: unknown) {
  const text = cleanText(value);
  return text.length > 0 ? text : null;
}

function cleanTime(value: unknown, fieldName: string) {
  const text = cleanText(value);
  if (!/^\d{2}:\d{2}$/.test(text)) {
    throw new Error(`${fieldName} must be HH:MM.`);
  }
  return text;
}

function cleanNumber(value: unknown, fieldName: string, options: { allowNull?: boolean; integer?: boolean } = {}) {
  const text = cleanText(value);
  if (text.length === 0 && options.allowNull) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`${fieldName} must be a number.`);
  if (options.integer && !Number.isInteger(number)) throw new Error(`${fieldName} must be a whole number.`);
  if (number < 0) throw new Error(`${fieldName} cannot be negative.`);
  return number;
}

function cleanDate(value: unknown, fieldName: string, options: { allowNull?: boolean } = {}) {
  const text = cleanText(value);
  if (!text && options.allowNull) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${fieldName} must be YYYY-MM-DD.`);
  return text;
}

function normalizeTarget(input: { targetType: unknown; targetValue: unknown }) {
  const targetType = cleanText(input.targetType) as AttendancePolicyTargetType;
  if (!["default", "job_title", "employee_hr_id"].includes(targetType)) {
    throw new Error("targetType must be default, job_title, or employee_hr_id.");
  }

  const targetValue = targetType === "default" ? null : nullableText(input.targetValue);
  if (targetType !== "default" && !targetValue) {
    throw new Error("targetValue is required for job title and HR_ID policies.");
  }

  return {
    targetType,
    targetValue: targetType === "employee_hr_id" ? targetValue?.toUpperCase() ?? null : targetValue,
  };
}

function formatTime(value: string) {
  return String(value ?? "").slice(0, 5);
}

function numberText(value: number | string | null) {
  return value == null ? "" : String(value);
}

function cleanWorkingWeekdays(value: unknown) {
  return normalizeAttendanceWorkingWeekdays(value);
}

function validatePolicyRules(rules: Array<{
  deduction_days: number | null;
  event_type: AttendancePolicyEventType;
  from_minutes: number | null;
  recommended_action: string;
  to_minutes: number | null;
}>) {
  rules.forEach((rule, index) => {
    if (rule.event_type !== "exception" && rule.deduction_days == null) {
      throw new Error(`Rule ${index + 1} deduction day fraction is required.`);
    }
    if (rule.from_minutes != null && rule.to_minutes != null && rule.to_minutes < rule.from_minutes) {
      throw new Error(`Rule ${index + 1} toMinutes cannot be before fromMinutes.`);
    }
  });

  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const left = rules[leftIndex];
      const right = rules[rightIndex];
      if (left.event_type !== right.event_type) continue;
      const leftFrom = left.from_minutes ?? 0;
      const leftTo = left.to_minutes ?? Number.POSITIVE_INFINITY;
      const rightFrom = right.from_minutes ?? 0;
      const rightTo = right.to_minutes ?? Number.POSITIVE_INFINITY;
      if (leftFrom <= rightTo && rightFrom <= leftTo) {
        throw new Error(`Rules ${leftIndex + 1} and ${rightIndex + 1} overlap for ${left.event_type}.`);
      }
    }
  }
}

export async function getAttendancePolicyDashboard(): Promise<AttendancePolicyDashboard> {
  const supabase = getSupabaseAdmin();
  const [policyRows, ruleResult, employeeResult, deviceMappedHrIds] = await Promise.all([
    loadAttendanceFlexPolicyGroups(),
    supabase
      .from("attendance_policy_rules")
      .select("id,policy_id,event_type,from_minutes,to_minutes,recommended_action,deduction_days,deduction_value,is_active,sort_order")
      .order("sort_order")
      .order("id"),
    supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title")
      .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
      .order("full_name"),
    loadActiveDeviceMappedHrIds(),
  ]);

  if (ruleResult.error) throw ruleResult.error;
  if (employeeResult.error) throw employeeResult.error;

  const rulesByPolicy = new Map<number, AttendancePolicyRule[]>();
  for (const rule of (ruleResult.data ?? []) as RuleDbRow[]) {
    const list = rulesByPolicy.get(rule.policy_id) ?? [];
    list.push({
      deductionDays: numberText(rule.deduction_days),
      deductionValue: numberText(rule.deduction_value),
      eventType: rule.event_type,
      fromMinutes: numberText(rule.from_minutes),
      id: rule.id,
      isActive: rule.is_active,
      recommendedAction: rule.recommended_action,
      sortOrder: rule.sort_order,
      toMinutes: numberText(rule.to_minutes),
    });
    rulesByPolicy.set(rule.policy_id, list);
  }

  const employeeRows = (employeeResult.data ?? []) as Array<{ full_name: string | null; hr_id: string; job_title: string | null; nickname: string | null }>;
  // Tracked = actively enrolled on a fingerprint device (office/HQ staff) OR a
  // field role by title (Medical Rep / DM / RSM). See isAttendanceTracked.
  const eligibleEmployeeRows = employeeRows.filter((row) =>
    isAttendanceTracked({
      hasDeviceMapping: deviceMappedHrIds.has(normalizeAttendanceHrId(row.hr_id) ?? ""),
      jobTitle: row.job_title,
    }),
  );
  const employees = eligibleEmployeeRows
    .filter((row) => row.hr_id)
    .map((row) => ({
      fullName: row.full_name?.trim() ? resolveEmployeeDisplayName(row.full_name.trim(), row.nickname, row.hr_id) : row.hr_id,
      hrId: row.hr_id,
    }))
    // The query sorts by the stored name; the list reads by the printed one.
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const jobTitles = Array.from(new Set(eligibleEmployeeRows.map((row) => row.job_title?.trim()).filter((value): value is string => Boolean(value)))).sort();

  const policies = (policyRows as PolicyDbRow[]).map((policy) => ({
    effectiveFrom: policy.effective_from,
    effectiveTo: policy.effective_to ?? "",
    graceMinutes: policy.grace_minutes,
    id: policy.id,
    isActive: policy.is_active,
    policyName: policy.policy_name,
    rules: rulesByPolicy.get(policy.id) ?? [],
    scheduledEnd: formatTime(policy.scheduled_end),
    scheduledStart: formatTime(policy.scheduled_start),
    targetType: policy.target_type,
    targetValue: policy.target_value ?? "",
    workingWeekdays: policy.working_weekdays ?? [],
    flexMinutes: policy.flex_minutes,
    requiredMinutes: policy.required_minutes,
    halfDaySplitMinutes: policy.half_day_split_minutes,
    judgmentMode: policy.judgment_mode,
  }));

  return {
    employees,
    jobTitles,
    policies,
    summary: summarizeAttendancePolicies(policies),
  };
}

export async function saveAttendancePolicy(input: {
  effectiveFrom: unknown;
  effectiveTo: unknown;
  graceMinutes: unknown;
  id?: unknown;
  isActive: unknown;
  policyName: unknown;
  rules: unknown;
  scheduledEnd: unknown;
  scheduledStart: unknown;
  targetType: unknown;
  targetValue: unknown;
  workingWeekdays?: unknown;
  flexMinutes?: unknown;
  requiredMinutes?: unknown;
  halfDaySplitMinutes?: unknown;
  judgmentMode?: unknown;
}) {
  const supabase = getSupabaseAdmin();
  const id = cleanNumber(input.id, "id", { allowNull: true, integer: true });
  const policyName = cleanText(input.policyName);
  const { targetType, targetValue } = normalizeTarget(input);
  const scheduledStart = cleanTime(input.scheduledStart, "scheduledStart");
  const scheduledEnd = cleanTime(input.scheduledEnd, "scheduledEnd");
  const workingWeekdays = cleanWorkingWeekdays(input.workingWeekdays);
  const graceMinutes = cleanNumber(input.graceMinutes, "graceMinutes", { integer: true }) as number;
  const effectiveFrom = cleanDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = cleanDate(input.effectiveTo, "effectiveTo", { allowNull: true });

  // Flexible-hours weekly-digest fields — optional; a policy not yet migrated
  // to the new model simply omits these and stays on the legacy engine.
  const flexMinutes = cleanNumber(input.flexMinutes, "flexMinutes", { allowNull: true, integer: true });
  const requiredMinutes = cleanNumber(input.requiredMinutes, "requiredMinutes", { allowNull: true, integer: true });
  const halfDaySplitMinutesRaw = cleanNumber(input.halfDaySplitMinutes, "halfDaySplitMinutes", { allowNull: true, integer: true });
  const halfDaySplitMinutes = halfDaySplitMinutesRaw ?? 780;
  const judgmentModeText = cleanText(input.judgmentMode) || "every_working_day";
  if (!["every_working_day", "office_days_only"].includes(judgmentModeText)) {
    throw new Error("judgmentMode must be every_working_day or office_days_only.");
  }
  const judgmentMode = judgmentModeText as "every_working_day" | "office_days_only";

  if (!policyName) throw new Error("policyName is required.");
  if (typeof input.isActive !== "boolean") throw new Error("isActive must be true or false.");
  if (!Array.isArray(input.rules)) throw new Error("rules must be an array.");
  if (graceMinutes > 240) throw new Error("graceMinutes cannot exceed 240.");

  if (targetType === "employee_hr_id" && targetValue) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id")
      .eq("hr_id", targetValue)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Employee HR_ID ${targetValue} does not exist.`);
  }

  const now = new Date().toISOString();

  const ruleRows = input.rules.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new Error(`Rule ${index + 1} must be an object.`);
    }
    const rule = rawRule as Record<string, unknown>;
    const eventType = cleanText(rule.eventType) as AttendancePolicyEventType;
    if (!["late", "early_leave", "single_punch", "absence", "exception"].includes(eventType)) {
      throw new Error(`Rule ${index + 1} eventType is invalid.`);
    }
    const recommendedAction = cleanText(rule.recommendedAction);
    if (!recommendedAction) throw new Error(`Rule ${index + 1} recommendedAction is required.`);

    return {
      deduction_days: cleanNumber(rule.deductionDays, `Rule ${index + 1} deductionDays`, { allowNull: true }),
      deduction_value: cleanNumber(rule.deductionValue, `Rule ${index + 1} deductionValue`, { allowNull: true }),
      event_type: eventType,
      from_minutes: cleanNumber(rule.fromMinutes, `Rule ${index + 1} fromMinutes`, { allowNull: true, integer: true }),
      is_active: typeof rule.isActive === "boolean" ? rule.isActive : true,
      recommended_action: recommendedAction,
      sort_order: index + 1,
      to_minutes: cleanNumber(rule.toMinutes, `Rule ${index + 1} toMinutes`, { allowNull: true, integer: true }),
    };
  });
  validatePolicyRules(ruleRows);

  // Single atomic RPC call — policy upsert + rule replacement in one transaction.
  // (The flexible-hours columns below are NOT part of this RPC — it's a live,
  // already-shipped SECURITY DEFINER function; rather than touch its SQL body,
  // they're applied in one small follow-up update immediately after.)
  const { data: savedId, error } = await supabase.rpc("phx_save_attendance_policy", {
    p_id:             id ?? null,
    p_policy_name:    policyName,
    p_target_type:    targetType,
    p_target_value:   targetValue ?? null,
    p_sched_start:    scheduledStart,
    p_sched_end:      scheduledEnd,
    p_grace_minutes:  graceMinutes,
    p_effective_from: effectiveFrom,
    p_effective_to:   effectiveTo ?? null,
    p_is_active:      input.isActive,
    p_weekdays:       workingWeekdays as number[],
    p_rules:          ruleRows,
    p_now:            now,
  });
  if (error) throw error;

  const policyId = (id ?? savedId) as number;
  const { error: flexError } = await supabase
    .from("attendance_policy_groups")
    .update({
      flex_minutes: flexMinutes,
      half_day_split_minutes: halfDaySplitMinutes,
      judgment_mode: judgmentMode,
      required_minutes: requiredMinutes,
      updated_at: now,
    })
    .eq("id", policyId);
  if (flexError) throw flexError;
}

export async function deleteAttendancePolicy(input: { id: unknown }) {
  const supabase = getSupabaseAdmin();
  const id = cleanNumber(input.id, "id", { integer: true });

  const { data, error } = await supabase
    .from("attendance_policy_groups")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Attendance policy was not found.");
}
