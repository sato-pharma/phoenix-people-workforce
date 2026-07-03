// Attendance passport: one employee's complete, read-only attendance-
// settlement history — every weekly digest, every settlement decision,
// every missing-punch case, and the summary stats over them. The per-
// employee counterpart to the org-wide settlement dashboard and the flat,
// cross-employee audit ledger.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { listSettlementLedger, type SettlementLedgerEntry } from "@/lib/attendance/settlement-ledger";
import { validationError } from "@/lib/http/api-errors";
import { hrIdLookupKeys } from "@/lib/hr-id";

export type PassportDigestSummary = {
  id: number;
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  status: "draft" | "sent" | "settled" | "auto_confirmed" | "void";
  totalDeductionDays: number;
  totalDeductionValue: number;
  sentAt: string | null;
};

export type PassportMissingPunchCase = {
  id: number;
  workDate: string;
  status: string;
  submittedAt: string | null;
  rejectedAtStep: string | null;
};

export type AttendancePassport = {
  employeeHrId: string;
  employeeName: string;
  digests: PassportDigestSummary[];
  settlements: SettlementLedgerEntry[];
  missingPunchCases: PassportMissingPunchCase[];
  stats: {
    totalDigests: number;
    confirmed: number;
    autoConfirmed: number;
    disputeUpheld: number;
    disputeRejected: number;
    disputeRate: number;
    totalDeductionDays: number;
    totalDeductionValueEgp: number;
    missingPunchCasesOpen: number;
  };
};

export async function getAttendancePassport(employeeHrId: string): Promise<AttendancePassport> {
  const hrId = normalizeAttendanceHrId(employeeHrId);
  if (!hrId) throw validationError("A valid employee HR ID is required.");

  const supabase = getSupabaseAdmin();

  const { data: employeeRows, error: employeeError } = await supabase
    .from("employees")
    .select("hr_id,full_name")
    .in("hr_id", hrIdLookupKeys(employeeHrId));
  if (employeeError) throw new Error(`Employee lookup failed: ${employeeError.message}`);
  const employeeRow = (employeeRows ?? [])[0];
  if (!employeeRow) throw validationError("Employee not found.");

  const { data: digestRows, error: digestError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,cycle_key,week_index,week_start,week_end,status,total_deduction_days,total_deduction_value,sent_at")
    .eq("employee_hr_id", hrId)
    .order("week_start", { ascending: false });
  if (digestError) throw new Error(`Digest history lookup failed: ${digestError.message}`);

  const digests: PassportDigestSummary[] = ((digestRows ?? []) as Array<{
    id: number;
    cycle_key: string;
    week_index: number;
    week_start: string;
    week_end: string;
    status: PassportDigestSummary["status"];
    total_deduction_days: number;
    total_deduction_value: number;
    sent_at: string | null;
  }>).map((row) => ({
    cycleKey: row.cycle_key,
    id: row.id,
    sentAt: row.sent_at,
    status: row.status,
    totalDeductionDays: Number(row.total_deduction_days),
    totalDeductionValue: Number(row.total_deduction_value),
    weekEnd: row.week_end,
    weekIndex: row.week_index,
    weekStart: row.week_start,
  }));

  const settlements = await listSettlementLedger({ employeeHrId: hrId });

  const { data: missingPunchRows, error: missingPunchError } = await supabase
    .from("attendance_missing_punch_verifications")
    .select("id,work_date,status,submitted_at,rejected_at_step")
    .eq("employee_hr_id", hrId)
    .order("work_date", { ascending: false });
  if (missingPunchError) throw new Error(`Missing-punch history lookup failed: ${missingPunchError.message}`);

  const missingPunchCases: PassportMissingPunchCase[] = ((missingPunchRows ?? []) as Array<{
    id: number;
    work_date: string;
    status: string;
    submitted_at: string | null;
    rejected_at_step: string | null;
  }>).map((row) => ({
    id: row.id,
    rejectedAtStep: row.rejected_at_step,
    status: row.status,
    submittedAt: row.submitted_at,
    workDate: row.work_date,
  }));

  const confirmed = settlements.filter((entry) => entry.action === "confirmed").length;
  const autoConfirmed = settlements.filter((entry) => entry.action === "auto_confirmed").length;
  const disputeUpheld = settlements.filter((entry) => entry.action === "dispute_upheld").length;
  const disputeRejected = settlements.filter((entry) => entry.action === "dispute_rejected").length;
  const disputeCount = disputeUpheld + disputeRejected;

  return {
    digests,
    employeeHrId: hrId,
    employeeName: employeeRow.full_name?.trim() || employeeRow.hr_id,
    missingPunchCases,
    settlements,
    stats: {
      autoConfirmed,
      confirmed,
      disputeRate: settlements.length > 0 ? disputeCount / settlements.length : 0,
      disputeRejected,
      disputeUpheld,
      missingPunchCasesOpen: missingPunchCases.filter((entry) => entry.status !== "fully_verified" && entry.status !== "rejected").length,
      totalDeductionDays: settlements.reduce((sum, entry) => sum + entry.deductionDays, 0),
      totalDeductionValueEgp: settlements.reduce((sum, entry) => sum + entry.deductionValue, 0),
      totalDigests: digests.length,
    },
  };
}
