import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
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
  /** True when the employee has at least 1 day of vacation balance — partial coverage is allowed. */
  balanceAvailable: boolean;
  /** The employee's actual remaining vacation-balance days as of this request. */
  balanceDaysAvailable: number;
  /**
   * Balance days that will actually be consumed (= Math.min(balanceDaysAvailable, unpaidDays)).
   * Equals unpaidDays when fully covered; less when partially covered.
   */
  balanceDaysToConsume: number;
  /** Days not covered by balance — these are deducted from salary. 0 when fully covered. */
  remainingSalaryDays: number;
  /** EGP salary deduction for the remaining days (dailyRate × remainingSalaryDays). 0 when fully covered. */
  remainingSalaryDeductionAmount: number;
  existingSettlement: {
    method: "salary" | "balance" | "partial_balance" | "defer_to_balance";
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
): Promise<Map<string, { method: "salary" | "balance" | "partial_balance" | "defer_to_balance"; decidedAt: string }>> {
  const map = new Map<string, { method: "salary" | "balance" | "partial_balance" | "defer_to_balance"; decidedAt: string }>();
  const { start, end } = periodBounds(period);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_vacation_settlements")
      .select("employee_hr_id_compact,start_date,settlement_method,decided_at")
      .is("superseded_at", null)
      .gte("start_date", start)
      .lte("start_date", end);
    if (error) {
      logError("Failed to load existing vacation settlements for period", {
        labels: { event: "vacation_settlement_existing_load_failed", month: period.month, year: period.year },
        error,
      });
      return map;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${String(row.employee_hr_id_compact ?? "")}:${String(row.start_date ?? "")}`;
      const rawMethod = String(row.settlement_method ?? "");
      const method: "salary" | "balance" | "partial_balance" | "defer_to_balance" =
        rawMethod === "balance"
          ? "balance"
          : rawMethod === "partial_balance"
            ? "partial_balance"
            : rawMethod === "defer_to_balance"
              ? "defer_to_balance"
              : "salary";
      map.set(key, { method, decidedAt: String(row.decided_at ?? "") });
    }
  } catch (error) {
    logError("Existing vacation settlements load threw an exception", {
      labels: { event: "vacation_settlement_existing_load_threw", month: period.month, year: period.year },
      error,
    });
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
    logError("Failed to load unpaid vacation requests for period", {
      labels: { event: "vacation_settlement_unpaid_requests_load_failed", month: period.month, year: period.year },
      error,
    });
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
    let balanceDaysAvailable = 0;
    try {
      const snapshot = await calculatePaymentForRequest({
        durationDays: unpaidDays,
        employeeHrId: hrId,
        excludeRequestId: String(row.id ?? ""),
        hireDate: employee?.hireDate ?? null,
        startDate,
        vacationType,
      });
      balanceDaysAvailable = snapshot.balanceBeforeDays;
      // Enable the balance button whenever the employee has ANY balance days —
      // partial coverage is allowed (remaining days are deducted from salary).
      balanceAvailable = balanceDaysAvailable > 0;
    } catch (balanceError) {
      logError("Vacation balance check failed for employee", {
        labels: { event: "vacation_settlement_balance_check_failed", hrId },
        error: balanceError,
      });
    }

    // How many days will actually be consumed from balance (capped at unpaidDays).
    const balanceDaysToConsume = roundCurrency(Math.min(balanceDaysAvailable, unpaidDays));
    const remainingSalaryDays = roundCurrency(Math.max(0, unpaidDays - balanceDaysToConsume));
    const remainingSalaryDeductionAmount = roundCurrency(dailyRate(baseSalary, period) * remainingSalaryDays);

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
      balanceDaysAvailable,
      balanceDaysToConsume,
      remainingSalaryDays,
      remainingSalaryDeductionAmount,
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
    // Include both full-salary settlements and partial-balance settlements —
    // both carry a salary_deduction_amount that must reach the payroll sheet.
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_vacation_settlements")
      .select("employee_hr_id_compact,salary_deduction_amount")
      .in("settlement_method", ["salary", "partial_balance"])
      .is("superseded_at", null)
      .gte("start_date", start)
      .lte("start_date", end);
    if (error) {
      logError("Failed to load settled vacation salary-deduction totals", {
        labels: { event: "vacation_settlement_salary_totals_load_failed", month: period.month, year: period.year },
        error,
      });
      return totals;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.employee_hr_id_compact ?? "");
      if (!key) continue;
      const amount = Number(row.salary_deduction_amount ?? 0);
      totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
    }
  } catch (error) {
    logError("Settled vacation salary-deduction totals load threw an exception", {
      labels: { event: "vacation_settlement_salary_totals_load_threw", month: period.month, year: period.year },
      error,
    });
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
  method: "salary" | "balance" | "partial_balance" | "defer_to_balance" | "reject";
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

  const isBalance = input.method === "balance";
  const isPartial = input.method === "partial_balance";
  const isDefer = input.method === "defer_to_balance";

  let salaryAmount: number | null = null;
  let balanceConsumed: number | null = null;

  if (isBalance || isDefer) {
    salaryAmount = null;
    balanceConsumed = input.candidate.unpaidDays;
  } else if (input.method === "salary") {
    salaryAmount = input.candidate.salaryDeductionAmount;
    balanceConsumed = null;
  } else if (isPartial) {
    salaryAmount = input.candidate.remainingSalaryDeductionAmount;
    balanceConsumed = input.candidate.balanceDaysToConsume;
  }

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
      salary_deduction_amount: salaryAmount,
      balance_days_consumed: balanceConsumed,
      decided_by: input.decidedBy,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (isBalance || isPartial) {
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
      logError("Vacation balance settlement email skipped: no work email on file", {
        labels: { event: "vacation_settlement_email_missing_work_email", hrId: candidate.employeeHrId },
      });
      return;
    }
    const manager = employee.managerHrId
      ? directory.employees.find((row) => compactHrKey(row.hrId) === compactHrKey(employee.managerHrId))
      : null;
    const hrRecipients = await getHrRecipients(directory);
    const cc = hrRecipients.map((recipient) => recipient.email).filter((email): email is string => Boolean(email));

    await sendVacationBalanceSettlementEmail({
      employeeDisplayName: employee.displayName,
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
    logError("Vacation balance settlement email failed to send", {
      labels: { event: "vacation_settlement_email_failed", hrId: candidate.employeeHrId },
      error,
    });
  }
}
