// Exportable audit ledger: a flat, read-only view over the immutable
// attendance_settlements table (every confirm / auto-confirm / dispute-review
// decision, ever) for a given date range — the record an HR/finance audit
// would ask for.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";

export type SettlementLedgerEntry = {
  id: number;
  employeeHrId: string;
  employeeName: string;
  workDate: string;
  action: "confirmed" | "auto_confirmed" | "dispute_upheld" | "dispute_rejected";
  lineStatus: string;
  deductionDays: number;
  deductionValue: number;
  actorHrId: string | null;
  actorRole: string | null;
  reviewerHrId: string | null;
  reason: string | null;
  decidedAt: string;
};

export type SettlementLedgerQuery = {
  dateFrom?: string;
  dateTo?: string;
  employeeHrId?: string;
};

const MAX_LEDGER_ROWS = 20000;

export async function listSettlementLedger(query: SettlementLedgerQuery = {}): Promise<SettlementLedgerEntry[]> {
  const supabase = getSupabaseAdmin();

  let request = supabase
    .from("attendance_settlements")
    .select("id,digest_line_id,employee_hr_id,work_date,action,deduction_days,deduction_value,actor_hr_id,actor_role,reviewer_hr_id,reason,decided_at")
    .order("decided_at", { ascending: false })
    .limit(MAX_LEDGER_ROWS);

  if (query.dateFrom) request = request.gte("work_date", query.dateFrom);
  if (query.dateTo) request = request.lte("work_date", query.dateTo);
  const normalizedEmployee = query.employeeHrId ? normalizeAttendanceHrId(query.employeeHrId) : null;
  if (normalizedEmployee) request = request.eq("employee_hr_id", normalizedEmployee);

  const { data, error } = await request;
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: number;
    digest_line_id: number;
    employee_hr_id: string;
    work_date: string;
    action: SettlementLedgerEntry["action"];
    deduction_days: number;
    deduction_value: number;
    actor_hr_id: string | null;
    actor_role: string | null;
    reviewer_hr_id: string | null;
    reason: string | null;
    decided_at: string;
  }>;
  if (rows.length === 0) return [];

  const lineIds = Array.from(new Set(rows.map((row) => row.digest_line_id)));
  const { data: lineRows, error: lineError } = await supabase
    .from("attendance_digest_lines")
    .select("id,status")
    .in("id", lineIds);
  if (lineError) throw lineError;
  const statusByLineId = new Map(((lineRows ?? []) as Array<{ id: number; status: string }>).map((row) => [row.id, row.status]));

  const employeeHrIds = Array.from(new Set(rows.map((row) => row.employee_hr_id)));
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

  return rows.map((row) => ({
    actorHrId: row.actor_hr_id,
    actorRole: row.actor_role,
    action: row.action,
    decidedAt: row.decided_at,
    deductionDays: Number(row.deduction_days),
    deductionValue: Number(row.deduction_value),
    employeeHrId: row.employee_hr_id,
    employeeName: nameByHrId.get(normalizeAttendanceHrId(row.employee_hr_id) ?? "") ?? row.employee_hr_id,
    id: row.id,
    lineStatus: statusByLineId.get(row.digest_line_id) ?? "unknown",
    reason: row.reason,
    reviewerHrId: row.reviewer_hr_id,
    workDate: row.work_date,
  }));
}
