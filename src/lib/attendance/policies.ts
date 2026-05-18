import { getSupabaseAdmin } from "@/lib/supabase/server";
import { summarizeAttendancePolicies } from "@/lib/attendance/metrics";

export type AttendancePolicyTargetType = "default" | "employee_hr_id" | "job_title";
export type AttendancePolicyEventType = "absence" | "early_leave" | "late" | "single_punch";

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

export async function getAttendancePolicyDashboard(): Promise<AttendancePolicyDashboard> {
  const supabase = getSupabaseAdmin();
  const [policyResult, ruleResult, employeeResult] = await Promise.all([
    supabase
      .from("attendance_policy_groups")
      .select("id,policy_name,target_type,target_value,scheduled_start,scheduled_end,grace_minutes,is_active,effective_from,effective_to")
      .order("target_type")
      .order("target_value")
      .order("effective_from", { ascending: false }),
    supabase
      .from("attendance_policy_rules")
      .select("id,policy_id,event_type,from_minutes,to_minutes,recommended_action,deduction_days,deduction_value,is_active,sort_order")
      .order("sort_order")
      .order("id"),
    supabase
      .from("employees")
      .select("hr_id,full_name,job_title")
      .order("full_name"),
  ]);

  if (policyResult.error) throw policyResult.error;
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

  const employeeRows = (employeeResult.data ?? []) as Array<{ full_name: string | null; hr_id: string; job_title: string | null }>;
  const employees = employeeRows
    .filter((row) => row.hr_id)
    .map((row) => ({ fullName: row.full_name?.trim() || row.hr_id, hrId: row.hr_id }));
  const jobTitles = Array.from(new Set(employeeRows.map((row) => row.job_title?.trim()).filter((value): value is string => Boolean(value)))).sort();

  const policies = ((policyResult.data ?? []) as PolicyDbRow[]).map((policy) => ({
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
}) {
  const supabase = getSupabaseAdmin();
  const id = cleanNumber(input.id, "id", { allowNull: true, integer: true });
  const policyName = cleanText(input.policyName);
  const { targetType, targetValue } = normalizeTarget(input);
  const scheduledStart = cleanTime(input.scheduledStart, "scheduledStart");
  const scheduledEnd = cleanTime(input.scheduledEnd, "scheduledEnd");
  const graceMinutes = cleanNumber(input.graceMinutes, "graceMinutes", { integer: true });
  const effectiveFrom = cleanDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = cleanDate(input.effectiveTo, "effectiveTo", { allowNull: true });

  if (!policyName) throw new Error("policyName is required.");
  if (typeof input.isActive !== "boolean") throw new Error("isActive must be true or false.");
  if (!Array.isArray(input.rules)) throw new Error("rules must be an array.");

  if (targetType === "employee_hr_id" && targetValue) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id")
      .eq("hr_id", targetValue)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Employee HR_ID ${targetValue} does not exist.`);
  }

  const policyRow = {
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    grace_minutes: graceMinutes,
    is_active: input.isActive,
    policy_name: policyName,
    scheduled_end: scheduledEnd,
    scheduled_start: scheduledStart,
    target_type: targetType,
    target_value: targetValue,
    updated_at: new Date().toISOString(),
  };

  let policyId = id;
  if (policyId) {
    const { error } = await supabase
      .from("attendance_policy_groups")
      .update(policyRow)
      .eq("id", policyId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from("attendance_policy_groups")
      .insert({ ...policyRow, created_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw error;
    policyId = (data as { id: number }).id;
  }

  const { error: deleteError } = await supabase
    .from("attendance_policy_rules")
    .delete()
    .eq("policy_id", policyId);
  if (deleteError) throw deleteError;

  const rules = input.rules.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new Error(`Rule ${index + 1} must be an object.`);
    }
    const rule = rawRule as Record<string, unknown>;
    const eventType = cleanText(rule.eventType) as AttendancePolicyEventType;
    if (!["late", "early_leave", "single_punch", "absence"].includes(eventType)) {
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
      policy_id: policyId,
      recommended_action: recommendedAction,
      sort_order: index + 1,
      to_minutes: cleanNumber(rule.toMinutes, `Rule ${index + 1} toMinutes`, { allowNull: true, integer: true }),
      updated_at: new Date().toISOString(),
    };
  });

  if (rules.length > 0) {
    const { error } = await supabase
      .from("attendance_policy_rules")
      .insert(rules);
    if (error) throw error;
  }
}
