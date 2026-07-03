// Read-side queries for the weekly-digest settlement flow: the employee's own
// digest list/detail, and the reviewer inbox of open disputes.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";

export type DigestLineView = {
  id: number;
  workDate: string;
  status: "late" | "short_hours" | "missing_punch";
  lateMinutes: number;
  shortMinutes: number;
  workedMinutes: number;
  deductionDays: number;
  deductionValue: number;
  reason: string;
  action: "pending" | "confirmed" | "disputed" | "auto_confirmed";
  disputeReason: string | null;
  disputeAttachmentUrl: string | null;
  /** Only set for status === "missing_punch". Null = no reason submitted yet. */
  missingPunchStatus: import("@/lib/attendance/missing-punch-verification").MissingPunchStatus | null;
};

export type DigestSummaryView = {
  id: number;
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  status: "draft" | "sent" | "settled" | "auto_confirmed" | "void";
  sentAt: string | null;
  autoConfirmAt: string | null;
  totalDeductionDays: number;
  totalDeductionValue: number;
  currency: string;
};

export type DigestDetailView = DigestSummaryView & { lines: DigestLineView[] };

function mapLine(row: Record<string, unknown>, missingPunchStatusByLineId?: Map<number, DigestLineView["missingPunchStatus"]>): DigestLineView {
  const id = Number(row.id);
  return {
    action: row.action as DigestLineView["action"],
    deductionDays: Number(row.deduction_days),
    deductionValue: Number(row.deduction_value),
    disputeAttachmentUrl: (row.dispute_attachment_url as string | null) ?? null,
    disputeReason: (row.dispute_reason as string | null) ?? null,
    id,
    lateMinutes: Number(row.late_minutes),
    missingPunchStatus: missingPunchStatusByLineId?.get(id) ?? null,
    reason: String(row.reason ?? ""),
    shortMinutes: Number(row.short_minutes),
    status: row.status as DigestLineView["status"],
    workDate: String(row.work_date),
    workedMinutes: Number(row.worked_minutes),
  };
}

async function loadMissingPunchStatusMap(lineIds: number[]): Promise<Map<number, DigestLineView["missingPunchStatus"]>> {
  const map = new Map<number, DigestLineView["missingPunchStatus"]>();
  if (lineIds.length === 0) return map;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_missing_punch_verifications")
    .select("digest_line_id,status")
    .in("digest_line_id", lineIds);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ digest_line_id: number; status: DigestLineView["missingPunchStatus"] }>) {
    map.set(row.digest_line_id, row.status);
  }
  return map;
}

function mapDigest(row: Record<string, unknown>): DigestSummaryView {
  return {
    autoConfirmAt: (row.auto_confirm_at as string | null) ?? null,
    currency: String(row.currency ?? "EGP"),
    cycleKey: String(row.cycle_key),
    id: Number(row.id),
    sentAt: (row.sent_at as string | null) ?? null,
    status: row.status as DigestSummaryView["status"],
    totalDeductionDays: Number(row.total_deduction_days),
    totalDeductionValue: Number(row.total_deduction_value),
    weekEnd: String(row.week_end),
    weekIndex: Number(row.week_index),
    weekStart: String(row.week_start),
  };
}

/** An employee's own digests, most recent cycle/week first. */
export async function listMyDigests(employeeHrId: string, limit = 12): Promise<DigestSummaryView[]> {
  const hrId = normalizeAttendanceHrId(employeeHrId);
  if (!hrId) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select("id,cycle_key,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,currency")
    .eq("employee_hr_id", hrId)
    .order("week_start", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapDigest);
}

/** One digest + its lines, scoped to the owning employee (never cross-employee). */
export async function getDigestDetailForEmployee(
  digestId: number,
  employeeHrId: string,
): Promise<DigestDetailView | null> {
  const hrId = normalizeAttendanceHrId(employeeHrId);
  if (!hrId) return null;

  const supabase = getSupabaseAdmin();
  const { data: digestRow, error: digestError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,cycle_key,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,currency")
    .eq("id", digestId)
    .eq("employee_hr_id", hrId)
    .maybeSingle();
  if (digestError) throw digestError;
  if (!digestRow) return null;

  const { data: lineRows, error: linesError } = await supabase
    .from("attendance_digest_lines")
    .select("id,work_date,status,late_minutes,short_minutes,worked_minutes,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
    .eq("digest_id", digestId)
    .order("work_date", { ascending: true });
  if (linesError) throw linesError;

  const rows = (lineRows ?? []) as Array<Record<string, unknown>>;
  const missingPunchLineIds = rows.filter((row) => row.status === "missing_punch").map((row) => Number(row.id));
  const missingPunchStatusByLineId = await loadMissingPunchStatusMap(missingPunchLineIds);

  return {
    ...mapDigest(digestRow as Record<string, unknown>),
    lines: rows.map((row) => mapLine(row, missingPunchStatusByLineId)),
  };
}

export type OpenDisputeView = DigestLineView & {
  digestId: number;
  employeeHrId: string;
  cycleKey: string;
  weekIndex: number;
};

/**
 * Every disputed line with no settlement outcome yet — the reviewer inbox.
 * Two-query approach (fetch disputed lines, then subtract already-settled
 * ones) rather than a DB join, matching the plain-select style already used
 * throughout this module.
 */
export async function listOpenDisputes(): Promise<OpenDisputeView[]> {
  const supabase = getSupabaseAdmin();
  const { data: lineRows, error: linesError } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,status,late_minutes,short_minutes,worked_minutes,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
    .eq("action", "disputed")
    .order("work_date", { ascending: true });
  if (linesError) throw linesError;
  const lines = (lineRows ?? []) as Array<Record<string, unknown>>;
  if (lines.length === 0) return [];

  const lineIds = lines.map((row) => Number(row.id));
  const { data: settledRows, error: settledError } = await supabase
    .from("attendance_settlements")
    .select("digest_line_id")
    .in("digest_line_id", lineIds);
  if (settledError) throw settledError;
  const settledIds = new Set(((settledRows ?? []) as Array<{ digest_line_id: number }>).map((row) => row.digest_line_id));
  const open = lines.filter((row) => !settledIds.has(Number(row.id)));
  if (open.length === 0) return [];

  const digestIds = Array.from(new Set(open.map((row) => Number(row.digest_id))));
  const { data: digestRows, error: digestError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,cycle_key,week_index")
    .in("id", digestIds);
  if (digestError) throw digestError;
  const digestById = new Map(
    ((digestRows ?? []) as Array<{ id: number; employee_hr_id: string; cycle_key: string; week_index: number }>).map((row) => [
      row.id,
      row,
    ]),
  );

  return open.map((row) => {
    const digest = digestById.get(Number(row.digest_id));
    return {
      ...mapLine(row),
      cycleKey: digest?.cycle_key ?? "",
      digestId: Number(row.digest_id),
      employeeHrId: digest?.employee_hr_id ?? "",
      weekIndex: digest?.week_index ?? 0,
    };
  });
}

/** Whether this HR_ID is currently an authorized dispute reviewer (Super Admin always is, as a safety valve). */
export async function isAuthorizedDisputeReviewer(hrId: string | null, isSuperAdmin: boolean): Promise<boolean> {
  if (isSuperAdmin) return true;
  const normalized = normalizeAttendanceHrId(hrId);
  if (!normalized) return false;
  const settings = await getDigestSettings();
  return settings.approverHrIds.includes(normalized);
}
