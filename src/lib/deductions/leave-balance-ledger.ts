// Deductions → "Deduct from leave balance": the READ side of the ledger.
//
// A CRM or CRM half-day deduction can be paid from the employee's annual leave instead of salary
// (owner, 2026-10-09). The charge lives in attendance_annual_balance_charges beside the weekly
// attendance review's, tagged source = 'deductions'; a give-back is a negative row on the same
// deduction. This file only READS that, and imports nothing from service.ts, so recordDecision (which
// must refuse to change a charged deduction) and the charge service (which calls recordDecision) can
// both depend on it without a cycle.

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One deduction currently paid from annual leave: the net days still charged and the comment written. */
export type LeaveBalanceCharge = {
  candidateId: string;
  /** Net days charged to annual leave (charges minus give-backs). Always above zero here. */
  days: number;
  /** The Super Admin's comment, exactly as written. This is what the employee reads. */
  comment: string;
  /** The day the deduction is for — the balance period the days count in. */
  workDate: string;
  chargedAt: string;
  chargedByHrId: string | null;
};

type LedgerRow = {
  id: number | string;
  deduction_candidate_id: string | null;
  employee_hr_id: string;
  work_date: string;
  days: number | string;
  comment: string | null;
  created_at: string;
  created_by: string | null;
  reverses_charge_id: number | string | null;
};

const LEDGER_COLUMNS = "id,deduction_candidate_id,employee_hr_id,work_date,days,comment,created_at,created_by,reverses_charge_id";

/** A missing table or column means the migration has not run, so no such charge can exist. */
export function isLedgerNotReadyError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  return code === "PGRST205" || code === "42P01" || code === "42703" || message.includes("could not find the table") || message.includes("does not exist");
}

/** Pure: fold ledger rows into the deductions still paid from annual leave. Exported for its test. */
export function foldLeaveBalanceCharges(rows: readonly LedgerRow[]): Map<string, LeaveBalanceCharge & { employeeHrId: string }> {
  const byCandidate = new Map<string, { net: number; charge: LedgerRow | null; employeeHrId: string }>();
  for (const row of rows) {
    const candidateId = row.deduction_candidate_id;
    if (!candidateId) continue;
    const entry = byCandidate.get(candidateId) ?? { net: 0, charge: null, employeeHrId: row.employee_hr_id };
    entry.net += Number(row.days) || 0;
    // The comment belongs to the latest CHARGE; a give-back row carries none.
    const days = Number(row.days) || 0;
    if (days > 0 && (!entry.charge || Number(row.id) > Number(entry.charge.id))) entry.charge = row;
    byCandidate.set(candidateId, entry);
  }
  const live = new Map<string, LeaveBalanceCharge & { employeeHrId: string }>();
  for (const [candidateId, entry] of byCandidate) {
    if (entry.net <= 0.0005 || !entry.charge) continue;
    live.set(candidateId, {
      candidateId,
      days: Math.round(entry.net * 1000) / 1000,
      comment: String(entry.charge.comment ?? ""),
      workDate: String(entry.charge.work_date),
      chargedAt: String(entry.charge.created_at),
      chargedByHrId: entry.charge.created_by,
      employeeHrId: entry.employeeHrId,
    });
  }
  return live;
}

async function readDeductionsRows(filter?: { employeeHrId?: string; candidateId?: string }): Promise<LedgerRow[]> {
  // Every row, page by page: the fold below nets charges against give-backs per deduction, so a read
  // cut short would drop a give-back (or the charge it reverses) and mis-state what is paid from leave.
  try {
    return await fetchAllRows<LedgerRow>(() => {
      let query = getSupabaseAdmin()
        .from("attendance_annual_balance_charges")
        .select(LEDGER_COLUMNS)
        .eq("source", "deductions");
      if (filter?.candidateId) query = query.eq("deduction_candidate_id", filter.candidateId);
      if (filter?.employeeHrId) {
        query = query.ilike("employee_hr_id", filter.employeeHrId.trim().replace(/[\\%_]/g, (char) => `\\${char}`));
      }
      return query;
    }, "id");
  } catch (error) {
    if (isLedgerNotReadyError(error)) return [];
    throw new Error(`Failed to read the leave balance charges: ${(error as { message?: string }).message ?? String(error)}`);
  }
}

/** Every deduction currently paid from annual leave, keyed by deduction id. */
export async function loadLiveLeaveBalanceCharges(): Promise<Map<string, LeaveBalanceCharge>> {
  return foldLeaveBalanceCharges(await readDeductionsRows());
}

/** The live charge on one deduction, or null when it is paid from salary. Fails closed on a failed read. */
export async function getLeaveBalanceChargeForCandidate(candidateId: string): Promise<LeaveBalanceCharge | null> {
  return foldLeaveBalanceCharges(await readDeductionsRows({ candidateId })).get(candidateId) ?? null;
}

/** What one employee's Vacation Report shows: their own deductions paid from annual leave. */
export async function listLeaveBalanceChargesForEmployees(employeeHrIds: readonly string[]): Promise<Array<LeaveBalanceCharge & { employeeHrId: string }>> {
  const wanted = new Set(employeeHrIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return [];
  const folded = foldLeaveBalanceCharges(await readDeductionsRows());
  return Array.from(folded.values())
    .filter((charge) => wanted.has(charge.employeeHrId.trim().toLowerCase()))
    .sort((left, right) => right.workDate.localeCompare(left.workDate));
}
