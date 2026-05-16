import {
  mapDayTypeToDurationUnit,
  mapPaymentStatusToDb,
  type VacationDayType,
  type VacationPaymentStatus,
  type VacationRequestType,
} from "@/lib/leave/requests";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { leaveTypeCodeByRequestType } from "@/lib/leave/workflow";

type LeaveRequestPersistenceClient = ReturnType<typeof getSupabaseAdmin>;

type LeaveRequestPersistenceError = {
  code?: string;
  message?: string;
};

type LeaveTypeLookupOptions = {
  requestType: VacationRequestType;
  dayType: VacationDayType;
  durationDays: number;
  halfDayImpact: number;
  totalDays: number;
  paymentStatus: VacationPaymentStatus;
  supabase: LeaveRequestPersistenceClient;
};

export type LeaveRequestPersistencePayload = {
  leave_type_id?: string;
  policy_id?: string;
  status: "pending_manager";
  manager_status: "pending";
  hr_status: "pending";
  payroll_status: "not_required";
  payment_status: "paid" | "unpaid" | "in_review";
  duration_unit: "full_day" | "am" | "pm";
  total_calendar_days: number;
  total_working_days: number;
};

function round2(value: number) {
  return Number(Number(value).toFixed(2));
}

function resolveRequestedTypeCode(requestType: VacationRequestType) {
  return leaveTypeCodeByRequestType[requestType] ?? leaveTypeCodeByRequestType.Other;
}

function toDecimal(value: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRelationMissingError(error: LeaveRequestPersistenceError | null | undefined) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST200" ||
    code === "PGRST204" ||
    message.includes('relation "leave_types" does not exist') ||
    message.includes('relation "leave_policies" does not exist')
  );
}

async function resolveLeaveTypeId(
  supabase: LeaveRequestPersistenceClient,
  requestType: VacationRequestType,
): Promise<string | null> {
  const code = resolveRequestedTypeCode(requestType);

  const byCode = await supabase
    .from("leave_types")
    .select("id")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  if (byCode.error) {
    if (isRelationMissingError(byCode.error)) {
      return null;
    }
    throw new Error(byCode.error.message || "Unable to resolve leave type.");
  }

  if (byCode.data?.id) {
    return String(byCode.data.id);
  }
  throw new Error(`Unable to resolve leave type for request type "${requestType}" using code "${code}".`);
}

async function resolvePolicyId(supabase: LeaveRequestPersistenceClient): Promise<string | null> {
  const defaultPolicy = await supabase
    .from("leave_policies")
    .select("id")
    .eq("is_default", true)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (defaultPolicy.error) {
    if (isRelationMissingError(defaultPolicy.error)) {
      return null;
    }
    throw new Error(defaultPolicy.error.message || "Unable to resolve leave policy.");
  }

  if (defaultPolicy.data?.id) {
    return String(defaultPolicy.data.id);
  }
  throw new Error("Unable to resolve active default leave policy.");
}

export async function resolveLeaveRequestPersistencePayload(
  input: LeaveTypeLookupOptions,
): Promise<LeaveRequestPersistencePayload> {
  const [
    leaveTypeId,
    policyId,
  ] = await Promise.all([
    resolveLeaveTypeId(input.supabase, input.requestType),
    resolvePolicyId(input.supabase),
  ]);

  if (!leaveTypeId) {
    throw new Error(`Leave type "${input.requestType}" is not configured in the active leave catalog.`);
  }

  if (!policyId) {
    throw new Error("Active default leave policy is missing.");
  }

  return {
    duration_unit: mapDayTypeToDurationUnit(input.dayType),
    leave_type_id: leaveTypeId,
    payroll_status: "not_required",
    payment_status: mapPaymentStatusToDb(input.paymentStatus),
    policy_id: policyId,
    manager_status: "pending",
    hr_status: "pending",
    status: "pending_manager",
    total_calendar_days: round2(toDecimal(input.durationDays + input.halfDayImpact)),
    total_working_days: round2(toDecimal(input.totalDays)),
  };
}
