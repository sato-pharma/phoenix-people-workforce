// Deductions → "Deduct from leave balance" / "Return to salary" (owner, 2026-10-09).
//
// A deduction counted in days can be taken from the employee's ANNUAL leave instead of from salary.
// It started with CRM and CRM half day and was widened the same day on his word — "also show the
// deduct from balance in unpaid and insufficient" — to Unpaid Vacation and Insufficient Balance
// Vacation; `LEAVE_BALANCE_CATEGORIES` in types.ts is the list all four gates read. His rulings:
//   - annual balance only
//   - when the balance is shorter than the deduction: take what is there, the rest stays on salary
//   - the comment is required and the employee reads it exactly as written (no notification)
//   - it can be undone with "Return to salary": the days go back and the row returns to Pending
//   - IT CHARGES THE ACCRUED DAYS EVEN INSIDE THE FIRST SIX MONTHS (owner, 2026-10-09, after the
//     widening: "accrued days, override the block"). That is not a detail — every live Unpaid
//     Vacation row on production is `first_six_months`, so without the override this button refused
//     every one of them. A first-year employee accrues 15/12 of a day per completed month from the
//     hire date, and the six-month rule blocks REQUESTING paid leave, not earning it; the Super
//     Admin pressing this button is deliberately spending days the employee has already earned so
//     that the salary is left alone. `allowFirstSixMonths` reaches calculateVacationPayment and
//     nothing else in the system passes it.
//
// THE BALANCE ARITHMETIC IS NOT COPIED HERE. How much annual leave an employee has left is
// calculatePaymentForRequest (the same call a leave request and the weekly attendance review price
// themselves with). What this file adds is the decision on top of it, and the write: one atomic
// database function charges the days under the per-employee lock a leave approval takes, refusing if
// the balance moved since it was read.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { balanceReadIsComplete } from "@/lib/attendance/digest-rules.ts";
import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { hrIdForStorage } from "@/lib/hr-id.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getVacationBalancePeriod, isWithinFirstSixMonths } from "@/lib/vacation/calculations";
import { calculatePaymentForRequest } from "@/lib/vacation/service";

import { getLeaveBalanceChargeForCandidate, type LeaveBalanceCharge } from "./leave-balance-ledger.ts";
import { loadActivePushedLineIdByCandidate } from "./pushed-lines.ts";
import { assertDeductionsDecisionActor } from "./permissions.ts";
import { recordDecision } from "./service.ts";
import { isLeaveBalanceCategory as categoryTakesLeaveBalance, type DeductionsDecision } from "./types.ts";

/**
 * The categories this button exists for live in `types.ts` — the one module here the admin workspace
 * and the database migration can both be checked against. Re-exported so this file stays the single
 * import for everything about the charge.
 */
export { LEAVE_BALANCE_CATEGORIES, isLeaveBalanceCategory } from "./types.ts";

const DAYS_EPSILON = 0.0005;

function roundDays(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Pure: how a deduction splits between annual leave and salary. `coverableDays` is how many of the
 * `dueDays` the balance can pay (null or zero when it cannot be worked out or is empty).
 */
export function planLeaveBalanceCharge(input: { dueDays: number; coverableDays: number | null }): {
  chargeDays: number;
  salaryDays: number;
} {
  const due = Number.isFinite(input.dueDays) && input.dueDays > 0 ? input.dueDays : 0;
  const coverable = input.coverableDays != null && Number.isFinite(input.coverableDays) ? Math.max(0, input.coverableDays) : 0;
  const chargeDays = roundDays(Math.min(due, coverable));
  return { chargeDays, salaryDays: roundDays(due - chargeDays) };
}

/**
 * Pure: the decision a charge leaves on the deduction. Fully covered → cleared, nothing on salary.
 * Part covered → approved for payroll for ONLY the days the balance could not pay.
 *
 * 🔴 `alreadyCleared` — the row was ALREADY "Do Not Take Action" before the charge (owner,
 * 2026-10-09: the button must work on a cleared row too). Nothing was on salary then, and a charge
 * must not put anything there: a part-covered cleared row takes what the balance has and the
 * remainder stays UNCHARGED, not approved for payroll. Without this, pressing the button on a
 * cleared row would silently turn a deduction he had waived into a payroll charge.
 */
export function decisionAfterLeaveBalanceCharge(input: {
  alreadyCleared?: boolean;
  chargeDays: number;
  salaryDays: number;
  dueDays: number;
  comment: string;
}): { status: "Do Not Take Action" | "Approved for Payroll"; reason: string; appliedValue: number | null } {
  const comment = input.comment.trim();
  if (input.salaryDays <= DAYS_EPSILON) {
    return {
      status: "Do Not Take Action",
      reason: `${LEAVE_BALANCE_REASON_FULL} (${input.chargeDays} day${input.chargeDays === 1 ? "" : "s"}). ${comment}`,
      appliedValue: null,
    };
  }
  if (input.alreadyCleared) {
    return {
      status: "Do Not Take Action",
      reason: `${LEAVE_BALANCE_REASON_PART} (${input.chargeDays} of ${input.dueDays} days); the remaining ${input.salaryDays} day${input.salaryDays === 1 ? "" : "s"} stay cleared and reach no salary. ${comment}`,
      appliedValue: null,
    };
  }
  return {
    status: "Approved for Payroll",
    reason: `${LEAVE_BALANCE_REASON_PART} (${input.chargeDays} of ${input.dueDays} days); ${input.salaryDays} day${input.salaryDays === 1 ? "" : "s"} stay on salary. ${comment}`,
    appliedValue: input.salaryDays,
  };
}

export const LEAVE_BALANCE_REASON_FULL = "Paid from the annual leave balance";
export const LEAVE_BALANCE_REASON_PART = "Partly paid from the annual leave balance";

/** Whether a decision reason was written by this button — used to finish an interrupted return. */
export function isLeaveBalanceReason(reason: string | null | undefined): boolean {
  const text = String(reason ?? "");
  return text.startsWith(LEAVE_BALANCE_REASON_FULL) || text.startsWith(LEAVE_BALANCE_REASON_PART);
}

function refusalText(reason: string | null): string {
  switch (reason) {
    case "missing_hire_date":
      return "The employee's hire date is not on file, so the annual balance cannot be worked out.";
    case "first_six_months":
      // Unreachable through this button since the override (the header), and kept rather than deleted
      // so a future reader who removes `allowFirstSixMonths` gets words instead of the default.
      return "The employee is in the first six months of employment, when annual balance cannot be used.";
    case "balance_unreadable":
      return "The annual balance could not be fully read right now. Try again shortly.";
    case "no_balance":
      return "The employee has no annual leave balance left to take this from.";
    default:
      return "The annual balance cannot be used for this deduction.";
  }
}

type BalanceRead = {
  coverableDays: number;
  availableDays: number | null;
  refusal: string | null;
  /** Still inside the first six months, so these are days accrued but not yet available to request. */
  withinFirstSixMonths: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  seenRequestDays: number | null;
  seenChargeDays: number | null;
  seenCopilotDays: number | null;
};

async function readBalanceInputs(employeeHrId: string, periodStart: string, periodEnd: string) {
  const { data, error } = await getSupabaseAdmin().rpc("phx_attendance_balance_inputs", {
    p_employee_hr_id: employeeHrId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
  if (error) throw new Error(`Failed to read the annual balance: ${(error as { message?: string }).message ?? String(error)}`);
  const row = (data ?? {}) as { requestDays?: unknown; chargeDays?: unknown; copilotDays?: unknown };
  return {
    requestDays: Number(row.requestDays) || 0,
    chargeDays: Number(row.chargeDays) || 0,
    copilotDays: Number(row.copilotDays) || 0,
  };
}

/** How many of `days` annual leave can pay for on `workDate`, with the figures the write re-checks. */
async function readLeaveBalance(input: { employeeHrId: string; hireDate: string | null; workDate: string; days: number }): Promise<BalanceRead> {
  const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate: input.hireDate, referenceDate: input.workDate });
  const seen = period ? await readBalanceInputs(input.employeeHrId, period.periodStart, period.periodEnd) : null;
  const withinFirstSixMonths = isWithinFirstSixMonths({ hireDate: input.hireDate, referenceDate: input.workDate });
  const unreadable = (refusal: string): BalanceRead => ({
    coverableDays: 0,
    availableDays: null,
    refusal,
    withinFirstSixMonths,
    periodStart: period?.periodStart ?? null,
    periodEnd: period?.periodEnd ?? null,
    seenRequestDays: seen?.requestDays ?? null,
    seenChargeDays: seen?.chargeDays ?? null,
    seenCopilotDays: seen?.copilotDays ?? null,
  });
  if (!period) return unreadable("missing_hire_date");

  let snapshot: Awaited<ReturnType<typeof calculatePaymentForRequest>>;
  try {
    // Fail closed: a payroll balance ledger that cannot be read refuses instead of counting as zero spent.
    snapshot = await calculatePaymentForRequest({
      // The override (file header): the accrued days are charged inside the first six months too.
      allowFirstSixMonths: true,
      durationDays: input.days,
      employeeHrId: input.employeeHrId,
      failClosedLedgerRead: true,
      hireDate: input.hireDate,
      startDate: input.workDate,
      vacationType: "annual",
    });
  } catch {
    return unreadable("balance_unreadable");
  }
  const readComplete =
    !seen ||
    balanceReadIsComplete({
      calculatorUsedDays: snapshot.usedPaidDays,
      carriedOverDebtDays: snapshot.carriedOverDebtDays,
      requestDays: seen.requestDays,
      chargeDays: seen.chargeDays,
      copilotDays: seen.copilotDays,
    });
  const samePeriod = snapshot.periodStart === period.periodStart && snapshot.periodEnd === period.periodEnd;
  if (!readComplete || !samePeriod) return unreadable("balance_unreadable");
  // `first_six_months` is NOT refused here any more — `allowFirstSixMonths` above means the snapshot
  // prices such a day against the accrued entitlement, and someone with nothing accrued yet falls
  // through to `no_balance` below like anyone else whose balance is empty.
  if (snapshot.unpaidReason === "missing_hire_date") {
    return { ...unreadable(snapshot.unpaidReason), availableDays: null };
  }
  const coverableDays = roundDays(Math.max(0, snapshot.paidDurationDays));
  return {
    coverableDays,
    availableDays: roundDays(Math.max(0, snapshot.balanceBeforeDays)),
    refusal: coverableDays <= DAYS_EPSILON ? "no_balance" : null,
    withinFirstSixMonths,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    seenRequestDays: seen?.requestDays ?? null,
    seenChargeDays: seen?.chargeDays ?? null,
    seenCopilotDays: seen?.copilotDays ?? null,
  };
}

type CandidateForCharge = {
  id: string;
  category: string;
  unit: string;
  employeeHrId: string;
  monthKey: string;
  lockedAt: string | null;
  supersededAt: string | null;
  rawValue: number;
  dates: string[];
  decisionStatus: string | null;
  decisionReason: string | null;
  appliedValue: number | null;
};

async function loadCandidateForCharge(candidateId: string): Promise<CandidateForCharge> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("id, category, unit, employee_hr_id, month_key, locked_at, superseded_at, raw_value, dates, deductions_decisions(decision_status, decision_reason, applied_value)")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the deduction: ${error.message}`);
  if (!data) throw new Error("Not found: that deduction does not exist.");
  const row = data as Record<string, unknown>;
  const nested = row.deductions_decisions as Record<string, unknown> | Array<Record<string, unknown>> | null;
  const decision = Array.isArray(nested) ? (nested[0] ?? null) : nested;
  return {
    id: String(row.id),
    category: String(row.category ?? ""),
    unit: String(row.unit ?? ""),
    employeeHrId: String(row.employee_hr_id ?? ""),
    monthKey: String(row.month_key ?? ""),
    lockedAt: (row.locked_at as string | null) ?? null,
    supersededAt: (row.superseded_at as string | null) ?? null,
    rawValue: Number(row.raw_value) || 0,
    dates: Array.isArray(row.dates) ? (row.dates as unknown[]).map(String).sort() : [],
    decisionStatus: decision ? String(decision.decision_status ?? "") || null : null,
    decisionReason: decision ? String(decision.decision_reason ?? "") || null : null,
    appliedValue: decision && decision.applied_value != null ? Number(decision.applied_value) : null,
  };
}

/** The employee row a leave-balance charge needs. */
type EmployeeForCharge = { hireDate: string | null; hasLeft: boolean; lastWorkingDate: string | null };

/**
 * The hire date the balance period hangs off, plus whether this person has LEFT.
 *
 * 🔴 It reads `employees` with NO employment-status filter, and that is deliberate — a deduction
 * raised while someone was still working stays chargeable after the resignation is recorded. The
 * consequence is what the dialog now says out loud: measured on production 2026-10-09, three of the
 * sixteen September Unpaid Vacation rows belong to people who have left (last working days 17 Sep,
 * 30 Sep and 04 Oct), and the button offered 5 and 1.25 days of balance on two of them with nothing
 * on screen to say so. The Vacation Report cannot show such a charge either: its Entitlements tab
 * lists active employees, so someone who has left has no row there to carry it.
 *
 * `hasDepartedEmployment` is the repo's one vocabulary for this (`@/lib/auth/session-lifecycle`) —
 * resigned, terminated and not_renewed, deliberately NOT the complement of active, so the 15
 * `historical_payroll_record` and 2 `system_placeholder` rows on production are never called leavers.
 */
async function loadEmployeeForCharge(employeeHrId: string): Promise<EmployeeForCharge> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hire_date, employment_status, last_working_date")
    .ilike("hr_id", employeeHrId.trim().replace(/[\\%_]/g, (char) => `\\${char}`))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to read the employee's hire date: ${error.message}`);
  const row = data as
    | { hire_date?: string | null; employment_status?: string | null; last_working_date?: string | null }
    | null;
  return {
    hireDate: (row?.hire_date ?? null) || null,
    hasLeft: hasDepartedEmployment(row?.employment_status),
    lastWorkingDate: (row?.last_working_date ?? null) || null,
  };
}

function assertChargeable(candidate: CandidateForCharge) {
  if (!categoryTakesLeaveBalance(candidate.category)) {
    throw new Error(
      "Validation: only a CRM, CRM half-day, unpaid vacation or insufficient balance vacation deduction can be taken from the leave balance.",
    );
  }
  if (candidate.unit !== "days") {
    throw new Error("Validation: only a deduction counted in days can be taken from the leave balance.");
  }
  if (candidate.supersededAt) {
    throw new Error("Conflict: this deduction was replaced by a newer one — reload and look again.");
  }
  if (candidate.lockedAt) {
    throw new Error("Conflict: this deduction is locked by a publication and can no longer be changed.");
  }
  if (!candidate.employeeHrId.trim()) {
    throw new Error("Validation: this deduction has no employee on it.");
  }
}

/**
 * The day the balance period is read from: the deduction's first date INSIDE its own month, else the
 * first of its month. A Head Office cycle row (deductions/cycle.ts) starts on the 22nd of the PREVIOUS
 * month — January's starts on 22 December — and anchoring there would charge January's payroll row to
 * last year's balance.
 */
export function anchorDate(candidate: Pick<CandidateForCharge, "monthKey" | "dates">): string {
  const monthKey = candidate.monthKey.slice(0, 7);
  const inMonth = candidate.dates.find((date) => /^\d{4}-\d{2}-\d{2}/.test(date) && date.startsWith(monthKey));
  return inMonth ? inMonth.slice(0, 10) : `${monthKey}-01`;
}

export type LeaveBalancePreview = {
  candidateId: string;
  employeeHrId: string;
  /** Days this deduction currently costs. */
  dueDays: number;
  /** Annual leave left before this deduction, null when it could not be worked out. */
  availableDays: number | null;
  /** Days that would come off annual leave. */
  chargeDays: number;
  /** Days that would stay on salary. Always 0 on an already-cleared row — see `alreadyCleared`. */
  salaryDays: number;
  /** Plain-words reason the button cannot be used, null when it can. */
  refusal: string | null;
  /**
   * The row is already "Do Not Take Action", so nothing is on salary. The charge is ALLOWED (owner,
   * 2026-10-09) — the day comes off the balance and the row stays cleared — but the dialog says so,
   * because this is the one case where the charge costs the employee a day and saves no money.
   */
  alreadyCleared: boolean;
  /** Days the balance cannot pay that will stay CLEARED rather than reach salary (cleared rows only). */
  uncollectedDays: number;
  /**
   * Still inside the first six months. The charge is allowed (owner, 2026-10-09) but the dialog
   * says so, because it spends leave the employee has accrued and cannot yet request directly.
   */
  withinFirstSixMonths: boolean;
  /**
   * This person has LEFT (resigned, terminated or not renewed). The charge is still allowed (owner,
   * 2026-10-09: allow it, but say he has left) and the dialog says so, because it spends a balance
   * the final settlement may already have paid out, and the Vacation Report cannot show it — a
   * leaver has no row on the Entitlements tab, which lists active employees.
   */
  employeeHasLeft: boolean;
  /** The day that person stopped working, for the words the dialog prints. Null when not recorded. */
  lastWorkingDate: string | null;
  /** Already charged: what is on the leave balance now. */
  charged: LeaveBalanceCharge | null;
};

async function previewFor(candidate: CandidateForCharge, preloaded?: EmployeeForCharge) {
  const dueDays = candidate.appliedValue != null ? candidate.appliedValue : candidate.rawValue;
  const employee = preloaded ?? (await loadEmployeeForCharge(candidate.employeeHrId));
  const balance = await readLeaveBalance({
    employeeHrId: candidate.employeeHrId,
    hireDate: employee.hireDate,
    workDate: anchorDate(candidate),
    days: dueDays,
  });
  const plan = planLeaveBalanceCharge({ dueDays, coverableDays: balance.coverableDays });
  return { dueDays, balance, plan, employee };
}

/** What pressing "Deduct from leave balance" would do — read only, for the confirmation dialog. */
export async function previewLeaveBalanceCharge(input: {
  actor: Pick<AccessContext, "role">;
  candidateId: string;
}): Promise<LeaveBalancePreview> {
  assertDeductionsDecisionActor(input.actor);
  const candidate = await loadCandidateForCharge(input.candidateId);
  // Read BEFORE the already-charged branch below: "this person has left" is worth knowing just as
  // much when the question is whether to RETURN a charge to salary.
  const employee = await loadEmployeeForCharge(candidate.employeeHrId);
  const charged = await getLeaveBalanceChargeForCandidate(candidate.id);
  if (charged) {
    return {
      candidateId: candidate.id,
      employeeHrId: candidate.employeeHrId,
      dueDays: roundDays(charged.days + (candidate.appliedValue ?? 0)),
      availableDays: null,
      chargeDays: charged.days,
      salaryDays: candidate.appliedValue ?? 0,
      refusal: null,
      alreadyCleared: false,
      uncollectedDays: 0,
      withinFirstSixMonths: false,
      employeeHasLeft: employee.hasLeft,
      lastWorkingDate: employee.lastWorkingDate,
      charged,
    };
  }
  assertChargeable(candidate);
  // The same release check the charge itself runs. Without it the dialog offered a charge the save
  // then refused — the one failure mode this button is designed against.
  const pushed = await loadActivePushedLineIdByCandidate(candidate.monthKey);
  const { dueDays, balance, plan } = await previewFor(candidate, employee);
  const alreadyCleared = candidate.decisionStatus === "Do Not Take Action";
  let refusal = plan.chargeDays > DAYS_EPSILON ? null : refusalText(balance.refusal ?? "no_balance");
  if (pushed.get(candidate.id)) {
    refusal = "This deduction was already released to the employee — withdraw it first, then take it from the leave balance.";
  }
  return {
    candidateId: candidate.id,
    employeeHrId: candidate.employeeHrId,
    dueDays,
    availableDays: balance.availableDays,
    chargeDays: plan.chargeDays,
    // A cleared row has nothing on salary and the charge must not put anything there.
    salaryDays: alreadyCleared ? 0 : plan.salaryDays,
    refusal,
    alreadyCleared,
    uncollectedDays: alreadyCleared ? plan.salaryDays : 0,
    withinFirstSixMonths: balance.withinFirstSixMonths,
    // SAID, never refused (owner, 2026-10-09). A deduction raised while someone was still working
    // stays his to take from the balance; what he could not see was that the person had gone.
    employeeHasLeft: employee.hasLeft,
    lastWorkingDate: employee.lastWorkingDate,
    charged: null,
  };
}

function rethrowRpcError(error: { code?: string; message?: string }): never {
  const message = error.message || "The leave balance could not be changed.";
  if (error.code === "40001" || error.code === "55000") throw new Error(`Conflict: ${message}`);
  if (error.code === "P0002") throw new Error(`Not found: ${message}`);
  if (error.code === "22023") throw new Error(`Validation: ${message}`);
  throw new Error(message);
}

/** Take a deduction from the employee's annual leave. Super Admin only. */
export async function chargeDeductionToLeaveBalance(input: {
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
  candidateId: string;
  comment: string;
}): Promise<{ chargedDays: number; salaryDays: number; decisionStatus: string; decision: DeductionsDecision }> {
  assertDeductionsDecisionActor(input.actor);
  const comment = String(input.comment ?? "").trim();
  if (!comment) throw new Error("Validation: write the comment the employee will read.");

  const candidate = await loadCandidateForCharge(input.candidateId);
  assertChargeable(candidate);
  // A row already "Do Not Take Action" is NO LONGER refused (owner, 2026-10-09). Clearing a row
  // stopped the salary deduction; whether the leave day is free as well is his call per row, and
  // the charge below leaves such a row cleared whatever the balance could pay.
  const alreadyCleared = candidate.decisionStatus === "Do Not Take Action";
  if (await getLeaveBalanceChargeForCandidate(candidate.id)) {
    throw new Error("Conflict: this deduction is already taken from the leave balance — reload and look again.");
  }
  const pushed = await loadActivePushedLineIdByCandidate(candidate.monthKey);
  if (pushed.get(candidate.id)) {
    throw new Error("Conflict: this deduction was already released to the employee — withdraw it first.");
  }

  const { dueDays, balance, plan } = await previewFor(candidate);
  if (plan.chargeDays <= DAYS_EPSILON || !balance.periodStart || !balance.periodEnd) {
    throw new Error(`Conflict: ${refusalText(balance.refusal ?? "no_balance")}`);
  }

  const actorHrId = input.actor.hrId ?? input.actor.loginId ?? null;
  const { error } = await getSupabaseAdmin().rpc("phx_deductions_charge_leave_balance", {
    p_candidate_id: candidate.id,
    p_employee_hr_id: hrIdForStorage(candidate.employeeHrId),
    p_work_date: anchorDate(candidate),
    p_days: plan.chargeDays,
    p_comment: comment,
    p_actor_hr_id: actorHrId ? hrIdForStorage(actorHrId) : null,
    p_period_start: balance.periodStart,
    p_period_end: balance.periodEnd,
    p_seen_request_days: balance.seenRequestDays,
    p_seen_charge_days: balance.seenChargeDays,
    p_seen_copilot_days: balance.seenCopilotDays,
  });
  if (error) rethrowRpcError(error as { code?: string; message?: string });

  const after = decisionAfterLeaveBalanceCharge({ ...plan, alreadyCleared, dueDays, comment });
  let decision: DeductionsDecision;
  try {
    decision = await recordDecision({
      actor: input.actor,
      candidateId: candidate.id,
      decisionStatus: after.status,
      decisionReason: after.reason,
      appliedValue: after.appliedValue,
      viaLeaveBalance: true,
    });
  } catch (decisionError) {
    // The days were taken but the row could not be updated — give them straight back so salary and
    // leave are never both left holding the same deduction.
    await getSupabaseAdmin()
      .rpc("phx_deductions_return_leave_balance", {
        p_candidate_id: candidate.id,
        p_reason: "Undone automatically: the deduction could not be updated.",
        p_actor_hr_id: actorHrId ? hrIdForStorage(actorHrId) : null,
      })
      .then(() => undefined, () => undefined);
    throw decisionError;
  }

  await writeAuditLog({
    actorLoginId: input.actor.loginId ?? input.actor.hrId ?? "unknown",
    entityId: candidate.id,
    entityType: "deductions_decision",
    newValues: { chargedDays: plan.chargeDays, salaryDays: after.appliedValue ?? 0, alreadyCleared, comment } as unknown as Record<string, unknown>,
    summary: `Deduction taken from the annual leave balance: ${plan.chargeDays} day(s)`,
  });
  return { chargedDays: plan.chargeDays, salaryDays: after.appliedValue ?? 0, decisionStatus: after.status, decision };
}

/** Undo a leave balance charge: the days go back and the deduction returns to Pending. Super Admin only. */
export async function returnDeductionToSalary(input: {
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
  candidateId: string;
  reason?: string;
}): Promise<{ returnedDays: number; decision: DeductionsDecision }> {
  assertDeductionsDecisionActor(input.actor);
  const candidate = await loadCandidateForCharge(input.candidateId);
  if (candidate.lockedAt) {
    throw new Error("Conflict: this deduction is locked by a publication and can no longer be changed.");
  }
  const actorHrId = input.actor.hrId ?? input.actor.loginId ?? null;
  const charged = await getLeaveBalanceChargeForCandidate(candidate.id);
  let returnedDays = 0;
  if (charged) {
    const { data, error } = await getSupabaseAdmin().rpc("phx_deductions_return_leave_balance", {
      p_candidate_id: candidate.id,
      p_reason: String(input.reason ?? "").trim() || "Returned to salary by the Super Admin.",
      p_actor_hr_id: actorHrId ? hrIdForStorage(actorHrId) : null,
    });
    if (error) rethrowRpcError(error as { code?: string; message?: string });
    returnedDays = Number((data as { returnedDays?: unknown } | null)?.returnedDays) || 0;
  } else if (!isLeaveBalanceReason(candidate.decisionReason)) {
    throw new Error("Conflict: this deduction is not taken from the leave balance — reload and look again.");
  }
  // A previous return that gave the days back but could not reset the row is finished here.
  const decision = await recordDecision({
    actor: input.actor,
    candidateId: candidate.id,
    decisionStatus: "Pending",
    decisionReason: "",
    appliedValue: null,
    appliedDates: null,
    viaLeaveBalance: true,
  });
  await writeAuditLog({
    actorLoginId: input.actor.loginId ?? input.actor.hrId ?? "unknown",
    entityId: candidate.id,
    entityType: "deductions_decision",
    newValues: { returnedDays } as unknown as Record<string, unknown>,
    summary: `Deduction returned to salary: ${returnedDays} day(s) given back to the annual leave balance`,
  });
  return { returnedDays, decision };
}
