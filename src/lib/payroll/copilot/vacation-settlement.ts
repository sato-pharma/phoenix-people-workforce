import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { roundCurrency } from "@/lib/payroll/money";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculatePaymentForRequest, getHrRecipients } from "@/lib/vacation/service";
import { sendVacationBalanceSettlementEmail } from "@/lib/vacation/email";
import type { VacationType } from "@/lib/vacation/types";

import { lookupSource } from "./assemble.ts";
import { compactHrKey } from "./feeders.ts";
import { dailyRate } from "./proration.ts";
import type { CopilotPeriod } from "./types.ts";

/**
 * Bridges the Payroll Copilot to a NEW settlement table
 * (payroll_copilot_vacation_settlements) that records the CEO's decision on
 * how an unpaid-leave request's cost is settled this cycle: deducted from
 * salary (the day-rate formula already used elsewhere in the Copilot), or
 * consumed from vacation balance instead (no salary deduction). Never
 * touches v2_vacation_requests — that table is owned by the vacation
 * approval workflow, decided by a different actor at a different time.
 *
 * Balance consumption is picked up by future balance checks via
 * src/lib/vacation/service.ts's approvedPaidDaysInPeriod, which sums live
 * (non-superseded) 'balance' settlements the same way it sums ordinary paid
 * requests — see that function for the exact query.
 */

export type UnpaidVacationCandidate = {
  requestId: string;
  employeeHrId: string;
  employeeName: string | null;
  vacationType: VacationType;
  startDate: string;
  endDate: string;
  unpaidDays: number;
  salaryDeductionAmount: number;
  /** True only when settling the FULL unpaid amount against balance would still leave the employee non-negative. */
  balanceAvailable: boolean;
  existingSettlement: {
    method: "salary" | "balance";
    decidedAt: string;
  } | null;
};

function periodBounds(period: CopilotPeriod): { start: string; end: string } {
  const mm = String(period.month).padStart(2, "0");
  const start = `${period.year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const end = `${period.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

async function loadExistingSettlements(
  period: CopilotPeriod,
): Promise<Map<string, { method: "salary" | "balance"; decidedAt: string }>> {
  const map = new Map<string, { method: "salary" | "balance"; decidedAt: string }>();
  const { start, end } = periodBounds(period);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_vacation_settlements")
      .select("employee_hr_id_compact,start_date,settlement_method,decided_at")
      .is("superseded_at", null)
      .gte("start_date", start)
      .lte("start_date", end);
    if (error) {
      console.error("[payroll-copilot:vacation-settlement] existing settlements load failed:", error);
      return map;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${String(row.employee_hr_id_compact ?? "")}:${String(row.start_date ?? "")}`;
      map.set(key, {
        method: row.settlement_method === "balance" ? "balance" : "salary",
        decidedAt: String(row.decided_at ?? ""),
      });
    }
  } catch (error) {
    console.error("[payroll-copilot:vacation-settlement] existing settlements load threw:", error);
  }
  return map;
}

/** Unpaid-leave candidates for the period with a computed salary-deduction value and live balance check. */
export async function listUnpaidVacationCandidates(period: CopilotPeriod): Promise<UnpaidVacationCandidate[]> {
  const { start, end } = periodBounds(period);
  const supabase = getSupabaseAdmin();

  const [{ data: requests, error }, directory, sources, existingSettlements] = await Promise.all([
    supabase
      .from("v2_vacation_requests")
      .select("id,employee_hr_id,employee_name,vacation_type,start_date,end_date,duration_days")
      .eq("payment_status", "unpaid")
      .in("status", ["approved", "pending_manager"])
      .lte("start_date", end)
      .gte("end_date", start),
    getEmployeeDirectory(),
    getPayrollSalarySourcesByHrId(period),
    loadExistingSettlements(period),
  ]);

  if (error) {
    console.error("[payroll-copilot:vacation-settlement] unpaid requests load failed:", error);
    return [];
  }

  const directoryByCompact = new Map(directory.employees.map((employee) => [compactHrKey(employee.hrId), employee]));
  const candidates: UnpaidVacationCandidate[] = [];

  for (const row of (requests ?? []) as Array<Record<string, unknown>>) {
    const hrId = String(row.employee_hr_id ?? "").trim();
    const compact = compactHrKey(hrId);
    if (!compact) continue;
    const employee = directoryByCompact.get(compact);
    const source = lookupSource(sources, hrId);
    const baseSalary = roundCurrency(source?.baseSalary ?? 0);
    const unpaidDays = Number(row.duration_days ?? 0);
    const startDate = String(row.start_date ?? "");
    const vacationType = (String(row.vacation_type ?? "annual") as VacationType) || "annual";

    const salaryDeductionAmount = roundCurrency(dailyRate(baseSalary, period) * unpaidDays);

    let balanceAvailable = false;
    try {
      const snapshot = await calculatePaymentForRequest({
        durationDays: unpaidDays,
        employeeHrId: hrId,
        excludeRequestId: String(row.id ?? ""),
        hireDate: employee?.hireDate ?? null,
        startDate,
        vacationType,
      });
      balanceAvailable = snapshot.paymentStatus === "paid";
    } catch (balanceError) {
      console.error("[payroll-copilot:vacation-settlement] balance check failed:", balanceError);
    }

    candidates.push({
      requestId: String(row.id ?? ""),
      employeeHrId: hrId,
      employeeName: employee?.fullName ?? (row.employee_name ? String(row.employee_name) : null),
      vacationType,
      startDate,
      endDate: String(row.end_date ?? ""),
      unpaidDays,
      salaryDeductionAmount,
      balanceAvailable,
      existingSettlement: existingSettlements.get(`${compact}:${startDate}`) ?? null,
    });
  }

  return candidates;
}

export type ApprovedVacationSalaryTotals = Map<string, number>;

/**
 * Per-employee sum of already-decided "deduct from salary" settlements for
 * the period, keyed by compact HR id — wired into assemble.ts's
 * unpaidVacations alongside the existing chat-driven prorate path. Defensive:
 * never throws, empty map on failure.
 */
export async function buildSettledSalaryDeductionTotals(period: CopilotPeriod): Promise<ApprovedVacationSalaryTotals> {
  const totals: ApprovedVacationSalaryTotals = new Map();
  const { start, end } = periodBounds(period);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_vacation_settlements")
      .select("employee_hr_id_compact,salary_deduction_amount")
      .eq("settlement_method", "salary")
      .is("superseded_at", null)
      .gte("start_date", start)
      .lte("start_date", end);
    if (error) {
      console.error("[payroll-copilot:vacation-settlement] salary totals load failed:", error);
      return totals;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.employee_hr_id_compact ?? "");
      if (!key) continue;
      const amount = Number(row.salary_deduction_amount ?? 0);
      totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
    }
  } catch (error) {
    console.error("[payroll-copilot:vacation-settlement] salary totals load threw:", error);
  }
  return totals;
}

/**
 * Records the CEO's decision for one unpaid-leave candidate. 'reject' simply
 * supersedes any existing live settlement (back to "no decision made" — the
 * request stays a plain unpaid absence with no payroll consequence from this
 * tab). 'balance' additionally fires the (idempotent) notification email.
 */
export async function recordVacationSettlementDecision(input: {
  runId: string;
  candidate: UnpaidVacationCandidate;
  method: "salary" | "balance" | "reject";
  decidedBy: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const compact = compactHrKey(input.candidate.employeeHrId);
  if (!compact) throw new Error("Invalid employee HR id for vacation settlement.");

  // Supersede any existing live settlement for this exact request first — a
  // re-decision (e.g. salary -> balance) must never leave two live rows.
  await supabase
    .from("payroll_copilot_vacation_settlements")
    .update({ superseded_at: new Date().toISOString() })
    .eq("employee_hr_id_compact", compact)
    .eq("start_date", input.candidate.startDate)
    .is("superseded_at", null);

  if (input.method === "reject") return;

  const { data, error } = await supabase
    .from("payroll_copilot_vacation_settlements")
    .insert({
      run_id: input.runId || null,
      employee_hr_id: input.candidate.employeeHrId,
      employee_hr_id_compact: compact,
      vacation_request_ids: [input.candidate.requestId],
      start_date: input.candidate.startDate,
      unpaid_days: input.candidate.unpaidDays,
      settlement_method: input.method,
      salary_deduction_amount: input.method === "salary" ? input.candidate.salaryDeductionAmount : null,
      balance_days_consumed: input.method === "balance" ? input.candidate.unpaidDays : null,
      decided_by: input.decidedBy,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (input.method === "balance") {
    await sendBalanceSettlementEmailSafely(input.candidate);
    await supabase
      .from("payroll_copilot_vacation_settlements")
      .update({ email_sent_at: new Date().toISOString() })
      .eq("id", (data as { id: string }).id);
  }
}

/** Best-effort — a notification failure must never undo or block a already-recorded settlement decision. */
async function sendBalanceSettlementEmailSafely(candidate: UnpaidVacationCandidate): Promise<void> {
  try {
    const directory = await getEmployeeDirectory();
    const compact = compactHrKey(candidate.employeeHrId);
    const employee = directory.employees.find((row) => compactHrKey(row.hrId) === compact);
    if (!employee?.workEmail) {
      console.error(`[payroll-copilot:vacation-settlement] no work email for ${candidate.employeeHrId}, email skipped`);
      return;
    }
    const manager = employee.managerHrId
      ? directory.employees.find((row) => compactHrKey(row.hrId) === compactHrKey(employee.managerHrId))
      : null;
    const hrRecipients = await getHrRecipients(directory);
    const cc = hrRecipients.map((recipient) => recipient.email).filter((email): email is string => Boolean(email));

    await sendVacationBalanceSettlementEmail({
      employeeEmail: employee.workEmail,
      managerEmail: manager?.workEmail ?? employee.workEmail,
      cc,
      request: {
        durationDays: candidate.unpaidDays,
        employeeHrId: candidate.employeeHrId,
        employeeName: candidate.employeeName ?? candidate.employeeHrId,
        endDate: candidate.endDate,
        id: candidate.requestId,
        startDate: candidate.startDate,
        vacationType: candidate.vacationType,
      },
      wouldHaveDeductedAmount: candidate.salaryDeductionAmount,
    });
  } catch (error) {
    console.error("[payroll-copilot:vacation-settlement] balance settlement email failed:", error);
  }
}
