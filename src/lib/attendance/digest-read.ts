// Read-side queries for the weekly-digest settlement flow: the employee's own
// digest list/detail, and the reviewer inbox of open disputes.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";

export type DigestLineView = {
  id: number;
  workDate: string;
  status: "late" | "short_hours" | "missing_punch";
  /** First punch, minutes since local midnight. Null if no punch. */
  checkInMinutes: number | null;
  /** Last punch, minutes since local midnight. Null if only one punch (no real checkout) or no punch. */
  checkOutMinutes: number | null;
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
  status: "draft" | "pending_admin_review" | "sent" | "settled" | "auto_confirmed" | "void";
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
    checkInMinutes: row.check_in_minutes === null || row.check_in_minutes === undefined ? null : Number(row.check_in_minutes),
    checkOutMinutes: row.check_out_minutes === null || row.check_out_minutes === undefined ? null : Number(row.check_out_minutes),
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

// None of these ever reaches the employee: 'draft' hasn't been decided
// (clean-send or admin-review) yet; 'pending_admin_review' means a real
// deduction was found and is sitting with the System Administrator / HR
// Manager; 'void' means an admin cancelled a pending-review digest before it
// ever sent (the only place this status is ever set — see voidDigestReview).
// In every case the employee must never see or infer that the stage existed.
const EMPLOYEE_HIDDEN_STATUSES = ["draft", "pending_admin_review", "void"] as const;

/** An employee's own digests, most recent cycle/week first. Never includes a digest still awaiting admin review. */
export async function listMyDigests(employeeHrId: string, limit = 12): Promise<DigestSummaryView[]> {
  const hrId = normalizeAttendanceHrId(employeeHrId);
  if (!hrId) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select("id,cycle_key,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,currency")
    .eq("employee_hr_id", hrId)
    .not("status", "in", `(${EMPLOYEE_HIDDEN_STATUSES.join(",")})`)
    .order("week_start", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapDigest);
}

/** One digest + its lines, scoped to the owning employee (never cross-employee, never a digest still awaiting admin review). */
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
    .not("status", "in", `(${EMPLOYEE_HIDDEN_STATUSES.join(",")})`)
    .maybeSingle();
  if (digestError) throw digestError;
  if (!digestRow) return null;

  const { data: lineRows, error: linesError } = await supabase
    .from("attendance_digest_lines")
    .select("id,work_date,status,check_in_minutes,check_out_minutes,late_minutes,short_minutes,worked_minutes,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
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
    .select("id,digest_id,work_date,status,check_in_minutes,check_out_minutes,late_minutes,short_minutes,worked_minutes,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
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

export type PendingDigestReviewView = DigestSummaryView & {
  employeeHrId: string;
  employeeName: string;
  lines: DigestLineView[];
};

/** Shared by listPendingDigestReviews and listSettledDigestReviews: fetches each digest's
 * lines and joins the employee's display name onto an already-fetched digest-row set. */
async function buildDigestReviewViews(digests: Array<Record<string, unknown>>): Promise<PendingDigestReviewView[]> {
  if (digests.length === 0) return [];
  const supabase = getSupabaseAdmin();

  const digestIds = digests.map((row) => Number(row.id));
  const { data: lineRows, error: linesError } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,status,check_in_minutes,check_out_minutes,late_minutes,short_minutes,worked_minutes,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
    .in("digest_id", digestIds)
    .order("work_date", { ascending: true });
  if (linesError) throw linesError;
  const linesByDigest = new Map<number, DigestLineView[]>();
  for (const row of (lineRows ?? []) as Array<Record<string, unknown>>) {
    const digestId = Number(row.digest_id);
    const list = linesByDigest.get(digestId) ?? [];
    list.push(mapLine(row));
    linesByDigest.set(digestId, list);
  }

  const employeeHrIds = Array.from(new Set(digests.map((row) => String(row.employee_hr_id))));
  const { data: employeeRows, error: employeeError } = await supabase
    .from("employees")
    .select("hr_id,full_name")
    .in("hr_id", employeeHrIds);
  if (employeeError) throw employeeError;
  const nameByHrId = new Map<string, string>();
  for (const row of (employeeRows ?? []) as Array<{ hr_id: string; full_name: string | null }>) {
    const hrId = normalizeAttendanceHrId(row.hr_id);
    if (hrId) nameByHrId.set(hrId, row.full_name?.trim() || row.hr_id);
  }

  return digests.map((row) => {
    const employeeHrId = String(row.employee_hr_id);
    return {
      ...mapDigest(row),
      employeeHrId,
      employeeName: nameByHrId.get(normalizeAttendanceHrId(employeeHrId) ?? "") ?? employeeHrId,
      lines: linesByDigest.get(Number(row.id)) ?? [],
    };
  });
}

/**
 * Every digest currently held for admin review — a real deduction was found
 * but it has NOT reached the employee yet. This is the admin's whole-company
 * queue, distinct from listMyDigests (self) and listOpenDisputes (post-send).
 */
export async function listPendingDigestReviews(): Promise<PendingDigestReviewView[]> {
  const supabase = getSupabaseAdmin();
  const { data: digestRows, error: digestError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,cycle_key,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,currency")
    .eq("status", "pending_admin_review")
    .order("week_start", { ascending: true });
  if (digestError) throw digestError;
  return buildDigestReviewViews((digestRows ?? []) as Array<Record<string, unknown>>);
}

/**
 * Every already-decided digest that carries a real deduction — the same row shape as the
 * pending-review inbox (name, date, late/short minutes, editable Days/Value/Reason), for the
 * digests that already went through Approve & Settle (or force-settle / recover-voided) and
 * so no longer show up in listPendingDigestReviews. Lets an admin find and correct a specific
 * already-settled line without going through raw SQL — owner rule 2026-07-21: the decision
 * report must show this shape for every real deduction, not just the ones still pending.
 */
export async function listSettledDigestReviews(): Promise<PendingDigestReviewView[]> {
  const supabase = getSupabaseAdmin();
  const { data: digestRows, error: digestError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,cycle_key,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,currency")
    .in("status", ["settled", "auto_confirmed"])
    .gt("total_deduction_value", 0)
    .order("week_start", { ascending: false });
  if (digestError) throw digestError;
  return buildDigestReviewViews((digestRows ?? []) as Array<Record<string, unknown>>);
}
