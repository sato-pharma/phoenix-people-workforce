import type { SupabaseClient } from "@supabase/supabase-js";

import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { roundCurrency } from "@/lib/payroll/money";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { PayrollConflictError } from "@/lib/payroll/errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculatePaymentForRequest, getHrRecipients } from "@/lib/vacation/service";
import { sendVacationBalanceSettlementEmail } from "@/lib/vacation/email";
import type { VacationType } from "@/lib/vacation/types";

import { lookupSource } from "./assemble.ts";
import { compactHrKey } from "./feeders.ts";
import { dailyRate } from "./proration.ts";
import {
  describeSlotHolder,
  HOLIDAY_BRIDGE_EXCLUDED_METHOD,
  type LiveSettlementSlotHolder,
  readLiveSettlementSlotHolder,
  SETTLEMENT_PAYMENT_METHODS,
  writeIntoSettlementSlot,
} from "./settlement-slot.ts";
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
      // ONLY the figure-bearing payment methods. This tab asks "how was this unpaid leave settled",
      // and a `holiday_bridge_excluded` row is not an answer to it — it is HR's marker that one
      // mandatory holiday-bridging day was excused. Both kinds compete for the same
      // (employee, start_date) slot, so without this filter a bridging exclusion was read back as
      // this tab's own decision.
      .in("settlement_method", SETTLEMENT_PAYMENT_METHODS)
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
      // FAIL CLOSED on anything unrecognised. This used to end `: "salary"`, so EVERY method it did
      // not know became a recorded salary deduction: the row rendered as the chosen decision, the
      // candidate stopped counting as pending (so it no longer blocked sheet generation,
      // service.ts), and the Unpaid Vacation workbook printed "From salary" and added the FULL
      // deduction to its total — while the payroll row itself deducted nothing, because
      // buildSettledSalaryDeductionTotals filters to salary/partial_balance. Two HR-facing artifacts
      // overstating a deduction the sheet does not take.
      //
      // Unreachable until 2026-10-01, when the method CHECK gained its fifth branch and
      // 'holiday_bridge_excluded' became storable. The `.in(...)` above already keeps those rows out;
      // this is the second line of defence, so the NEXT method added fails closed too. A method this
      // tab does not own means "no decision recorded here", which leaves the candidate pending.
      const method = SETTLEMENT_PAYMENT_METHODS.find((known) => known === rawMethod);
      if (!method) continue;
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
export async function buildSettledSalaryDeductionTotals(
  period: CopilotPeriod,
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<ApprovedVacationSalaryTotals> {
  const totals: ApprovedVacationSalaryTotals = new Map();
  const { start, end } = periodBounds(period);
  try {
    // Include both full-salary settlements and partial-balance settlements —
    // both carry a salary_deduction_amount that must reach the payroll sheet.
    const { data, error } = await client
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
 * Records the CEO's decision for one unpaid-leave candidate. 'reject' retires this request's own
 * live settlement (back to "no decision made" — the request stays a plain unpaid absence with no
 * payroll consequence from this tab). 'balance' additionally fires the (idempotent) notification
 * email.
 *
 * THE INSERT GOES FIRST, AND NOTHING IS RETIRED UNTIL IT IS KNOWN TO BE REPLACEABLE.
 *
 * This used to supersede first and insert second, and the supersede was scoped to
 * employee_hr_id_compact + start_date AND NOTHING ELSE — no method, no request — with its own error
 * discarded. Both halves are the defect removed from the automated-payroll writer in #5032, where
 * the same unscoped supersede destroyed a real employee's leave settlement on production on
 * 2026-08-04: a payroll run retired Khaled Mohamed Ali Bedair's 1.00-day balance settlement of
 * 2026-07-12, written by `system:crm-correction-2026-07-21`, and replaced it with nothing.
 *
 * This writer could reach the very same rows. `..._live_idx` is UNIQUE over
 * (employee_hr_id_compact, start_date) WHERE superseded_at IS NULL, so every writer of this ledger
 * competes for one slot per employee+date, and production still carries exactly such a row today —
 * B-185's 2.00-day balance settlement of 2026-07-09, decided by `system:crm-correction-2026-07-21`
 * with no request id. An unscoped supersede here would retire it. Since 2026-10-01 a holiday-bridging
 * exclusion can hold that slot too, so the unscoped form would also silently hand an employee back a
 * mandatory holiday-bridging deduction HR had excused.
 *
 * So the slot's holder is identified before anything is touched, and only a row that is THIS
 * request's own earlier answer may be superseded: a Copilot decision always stores
 * vacation_request_ids = [requestId], while a CRM-sourced correction stores [] — that is the
 * documented way the two are told apart. A slot held by anyone else is reported, never cleared.
 */
export async function recordVacationSettlementDecision(
  input: {
    runId: string;
    candidate: UnpaidVacationCandidate;
    method: "salary" | "balance" | "partial_balance" | "defer_to_balance" | "reject";
    decidedBy: string;
  },
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<void> {
  const supabase = client;
  const compact = compactHrKey(input.candidate.employeeHrId);
  if (!compact) throw new Error("Invalid employee HR id for vacation settlement.");

  const labels = {
    event: "vacation_settlement_decision",
    hrId: input.candidate.employeeHrId,
    startDate: input.candidate.startDate,
    runId: input.runId || null,
  };

  /** This request's OWN earlier answer — the only row a re-decision may retire. */
  const isOwnEarlierDecision = (holder: LiveSettlementSlotHolder): boolean =>
    holder.settlementMethod !== HOLIDAY_BRIDGE_EXCLUDED_METHOD &&
    holder.vacationRequestIds.includes(input.candidate.requestId);

  // 'reject' is a pure retirement with no replacement row, so there is no insert to lead with: read
  // the holder and retire it only if it is this request's own. A free slot is already the state
  // reject wants, so that is a no-op rather than an error.
  if (input.method === "reject") {
    const { holder, error: holderError } = await readLiveSettlementSlotHolder(
      supabase,
      compact,
      input.candidate.startDate,
    );
    if (holderError) {
      logError("Vacation settlement rejection could not read the live slot — nothing was retired", {
        labels: { ...labels, event: "vacation_settlement_reject_slot_unreadable" },
        error: holderError,
      });
      throw holderError;
    }
    if (!holder) return;
    if (!isOwnEarlierDecision(holder)) {
      logError("Vacation settlement rejection found the slot held by another decision — left alone", {
        labels: {
          ...labels,
          event: "vacation_settlement_reject_slot_held_by_another_decider",
          heldByMethod: holder.settlementMethod,
          heldByDecider: holder.decidedBy,
        },
      });
      throw new PayrollConflictError(
        `This leave day carries ${await describeSlotHolder(holder)}, which this request did not record, so rejecting here would destroy it. Nothing has been changed.`,
      );
    }
    const { error: rejectError } = await supabase
      .from("payroll_copilot_vacation_settlements")
      .update({ superseded_at: new Date().toISOString() })
      .eq("id", holder.id)
      .is("superseded_at", null);
    if (rejectError) {
      logError("Vacation settlement rejection failed — the earlier settlement still stands", {
        labels: { ...labels, event: "vacation_settlement_reject_failed" },
        error: rejectError,
      });
      throw rejectError;
    }
    return;
  }

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

  const row = {
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
  };

  const outcome = await writeIntoSettlementSlot(supabase, {
    employeeHrIdCompact: compact,
    startDate: input.candidate.startDate,
    row,
    ownsHolder: isOwnEarlierDecision,
  });

  if (outcome.kind === "conflict") {
    logError("Vacation settlement slot is held by a decision this request did not make — left alone", {
      labels: {
        ...labels,
        event: "vacation_settlement_slot_held_by_another_decider",
        heldByMethod: outcome.holder.settlementMethod,
        heldByDecider: outcome.holder.decidedBy,
      },
    });
    throw new PayrollConflictError(
      `This leave day already carries ${await describeSlotHolder(outcome.holder)}, which this request did not record, so it cannot be overwritten here. If that is a holiday-bridging exclusion, lift it with Include on the Holiday Bridging tab first. Nothing has been changed.`,
    );
  }

  if (outcome.kind === "failed") {
    logError(
      outcome.retiredAndNotReplaced
        ? "Vacation settlement was retired, its replacement failed, and it could NOT be put back"
        : "Vacation settlement could not be recorded — nothing was retired",
      {
        labels: {
          ...labels,
          event: outcome.retiredAndNotReplaced
            ? "vacation_settlement_retired_and_unrestored"
            : "vacation_settlement_write_failed",
        },
        error: outcome.error,
      },
    );
    throw outcome.error;
  }

  if (isBalance || isPartial) {
    await sendBalanceSettlementEmailSafely(input.candidate);
    // The settlement is already recorded, so a missing id must never be read as a failure of the
    // decision — only the email stamp is lost, and the send is idempotent anyway.
    const { holder: stored } = await readLiveSettlementSlotHolder(supabase, compact, input.candidate.startDate);
    const settlementId = stored?.id;
    if (settlementId) {
      await supabase
        .from("payroll_copilot_vacation_settlements")
        .update({ email_sent_at: new Date().toISOString() })
        .eq("id", String(settlementId));
    } else {
      logError("Vacation settlement email stamp skipped: the settlement row's id could not be resolved", {
        labels: { ...labels, event: "vacation_settlement_email_stamp_id_missing" },
      });
    }
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
