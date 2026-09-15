// The weekly attendance review's rules, as pure functions — no database, no clock — so the tests
// can pin them directly.
//
// Owner decision 2026-09-15, replacing the 2026-09-08 "silent" ruling:
//   • a closed week waits on the admin review page until the Super Admin releases it
//   • the employee then chooses, per day: deduct from SALARY, or from ANNUAL BALANCE (the same
//     number of days, only when the balance covers them)
//   • after choosing, the employee may dispute the day; the dispute goes to the reviewer
//   • a day nobody answered within 2 working days of the release is deducted from salary

import type { DeductionsDecisionStatus } from "@/lib/deductions/types.ts";

export type DigestStatus = "awaiting_release" | "open" | "settled" | "void";

export type DigestLineAction =
  | "pending"
  | "removed"
  | "salary"
  | "annual_balance"
  | "auto_salary"
  | "disputed"
  | "dispute_upheld"
  | "dispute_rejected"
  /** The 2026-09-08 answer. Kept readable; nothing writes it any more. */
  | "confirmed";

export type DeductionMethod = "salary" | "annual_balance";

export const DEDUCTION_METHODS: readonly DeductionMethod[] = ["salary", "annual_balance"];

export function isDeductionMethod(value: unknown): value is DeductionMethod {
  return value === "salary" || value === "annual_balance";
}

/** A line that still needs somebody — the employee (pending) or the reviewer (disputed). */
export function isOpenLineAction(action: string): boolean {
  return action === "pending" || action === "disputed";
}

/**
 * What the month-end deductions queue should do with a settled day.
 *
 * A day paid from annual balance is NOT a payroll deduction: the leave ledger carries it
 * (attendance_annual_balance_charges), so the fingerprint candidate is closed with "Do Not Take
 * Action" and a reason that says where the day went. Anything else would take the day twice —
 * once from leave, once from pay.
 */
export function decisionForSettlement(
  action: string,
  method: string | null | undefined,
): { status: DeductionsDecisionStatus; reason: string } | null {
  switch (action) {
    case "confirmed":
      return { status: "Approved for Payroll", reason: "Employee confirmed this day in their weekly attendance review." };
    case "salary":
      return { status: "Approved for Payroll", reason: "Employee chose to have this day deducted from salary." };
    case "auto_salary":
      return {
        status: "Approved for Payroll",
        reason: "Not answered within the deadline after the week was released, so it was deducted from salary.",
      };
    case "annual_balance":
      return { status: "Do Not Take Action", reason: "Charged to the employee's annual vacation balance at their choice." };
    case "dispute_rejected":
      return method === "annual_balance"
        ? { status: "Do Not Take Action", reason: "Dispute rejected; charged to the annual vacation balance the employee chose." }
        : { status: "Approved for Payroll", reason: "Dispute rejected; deducted from salary as the employee chose." };
    case "dispute_upheld":
      return { status: "Do Not Take Action", reason: "Dispute upheld — the day was covered." };
    case "removed":
      return { status: "Do Not Take Action", reason: "Removed from the weekly attendance review before it was released." };
    default:
      return null;
  }
}

/**
 * Whether a day's month-end fingerprint deduction still lets the employee pay it from annual
 * balance. Only an undecided, unlocked deduction does: the balance charge is permanent, and salary
 * is spared only because the bridge later closes that deduction with "Do Not Take Action" — which
 * it can do only while nobody has ruled on it and no publication has locked it. No deduction yet
 * is fine (the connector builds them at month end, and the bridge applies the answer then).
 * The settle function in the database refuses on exactly the same condition.
 */
export function payrollDecisionBlocksBalance(candidate: { lockedAt: string | null; decisionStatus: string | null } | null): boolean {
  if (!candidate) return false;
  if (candidate.lockedAt) return true;
  return (candidate.decisionStatus ?? "Pending") !== "Pending";
}

/**
 * Whether the balance the vacation calculator used saw every day already spent in this period. The
 * calculator reads leave requests by exact HR id, so it can under-count; the database sums match
 * case-insensitively. If the calculator saw LESS than the database holds, its "covers" answer
 * cannot be trusted.
 *
 * The calculator's used figure INCLUDES debt carried from earlier periods, so the debt is taken
 * back out first. Left in, 3 days of debt would hide 3 days the calculator failed to see, and the
 * check would pass on a balance that is really 3 days smaller.
 */
export function balanceReadIsComplete(input: {
  calculatorUsedDays: number;
  carriedOverDebtDays: number;
  requestDays: number;
  chargeDays: number;
  copilotDays: number;
}): boolean {
  const authoritative = input.requestDays + input.chargeDays + input.copilotDays;
  const calculatorThisPeriod = input.calculatorUsedDays - Math.max(0, input.carriedOverDebtDays);
  // The calculator rounds to 2 decimals and a charge can carry 3.
  return calculatorThisPeriod + 0.01 >= authoritative;
}

/**
 * Removing a day and releasing a week: the Super Admin ONLY (owner, 2026-09-15 — "i must approve
 * this"). A removal waives a colleague's deduction with nobody else looking, and a release is what
 * notifies every employee, so a named dispute reviewer gets neither.
 */
export function canManageWeeklyReview(access: { role?: string | null }): boolean {
  return access.role === "Super Admin";
}

/**
 * What a rejected dispute records when the employee chose annual balance and it can no longer be
 * used. Says the real cause: "the balance no longer covered it" is wrong when the month-end review
 * had already decided the day, and in that case that decision, not this one, is what payroll takes.
 */
export function disputeSalaryFallbackText(refusal: string | null): string {
  switch (refusal) {
    case "payroll_decided":
      return "Annual balance could not be used because the month-end deductions review had already decided this day; that decision stands.";
    case "first_six_months":
      return "Annual balance cannot be used during the first six months of employment, so salary applies.";
    case "missing_hire_date":
      return "Annual balance could not be worked out because the hire date is not on file, so salary applies.";
    case "insufficient_balance":
      return "The annual balance no longer covered this day, so salary applies.";
    default:
      return "Annual balance could not be used for this day, so salary applies.";
  }
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The last day an employee can still answer: the Nth working day AFTER the release date.
 *
 * Released on a Sunday with 2 working days → Monday and Tuesday are the two days, and the answer
 * is due by the end of Tuesday. The release day itself never counts — a week released at 11pm
 * must not have spent half its window already. Capped at 60 calendar days so a predicate that
 * never says "working" (a broken calendar) cannot loop forever; the cap falls back to the plain
 * calendar count, which is the most generous reading the employee could be given.
 */
export function answerDueDate(input: {
  releasedOnIso: string;
  workingDays: number;
  isWorkingDay: (dateIso: string) => boolean;
}): string {
  const wanted = Math.max(1, Math.floor(input.workingDays));
  let counted = 0;
  let cursor = input.releasedOnIso;
  for (let step = 0; step < 60; step += 1) {
    cursor = addDaysIso(cursor, 1);
    if (input.isWorkingDay(cursor)) {
      counted += 1;
      if (counted === wanted) return cursor;
    }
  }
  return addDaysIso(input.releasedOnIso, wanted);
}

/** Overdue only once the due date has fully passed in Cairo — the due date itself is still open. */
export function isAnswerOverdue(answerDueOnIso: string | null, todayCairoIso: string): boolean {
  if (!answerDueOnIso) return false;
  return todayCairoIso > answerDueOnIso;
}

/**
 * The deadline runs only for an employee who was actually told. A week whose notice never reached
 * them stays answerable, and silence there is never settled to salary — the review page shows
 * who was not notified.
 */
export function deadlineApplies(input: { answerDueOn: string | null; notifiedAt: string | null; todayCairoIso: string }): boolean {
  return Boolean(input.notifiedAt) && isAnswerOverdue(input.answerDueOn, input.todayCairoIso);
}

/**
 * Whether a release notice reached the employee on at least one of its two channels. A notice the
 * notification system skipped (in-app switched off, governance refusal, no Telegram link and no
 * in-app) did not tell anyone, and must not start the clock that ends in a salary deduction.
 */
export function releaseNoticeReached(deliveries: ReadonlyArray<{ channel: string; status: string }>): boolean {
  return deliveries.some(
    (delivery) =>
      (delivery.channel === "in_app" || delivery.channel === "telegram") &&
      (delivery.status === "sent" || delivery.status === "pending" || delivery.status === "retrying"),
  );
}

/**
 * Whether annual balance can pay for a day. The same number of days, all of it, or not at all —
 * a part-paid day would leave the rest to fall on salary without anyone having chosen that.
 */
export function balanceCoversDays(input: {
  days: number;
  paidDurationDays: number;
  unpaidReason: string | null;
}): boolean {
  if (!(input.days > 0)) return false;
  if (input.unpaidReason) return false;
  return input.paidDurationDays + 1e-9 >= input.days;
}

// The release notice. No amount: Telegram is a lock-screen channel, and the amount is one tap away.
function formatShortDay(dateIso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${dateIso}T00:00:00Z`),
  );
}

function formatDueDay(dateIso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${dateIso}T00:00:00Z`),
  );
}

export function buildWeekReleasedMessage(input: { weekStart: string; weekEnd: string; dayCount: number; answerDueOn: string }) {
  const days = input.dayCount === 1 ? "1 day" : `${input.dayCount} days`;
  return {
    title: `Attendance review — ${formatShortDay(input.weekStart)} to ${formatShortDay(input.weekEnd)}`,
    message:
      `Your attendance for ${formatShortDay(input.weekStart)} to ${formatShortDay(input.weekEnd)} has ${days} with a deduction.\n\n` +
      `For each day, choose whether it is deducted from your salary or from your annual vacation balance. ` +
      `After choosing, you can dispute the day if you believe it is wrong.\n\n` +
      `Please answer by the end of ${formatDueDay(input.answerDueOn)}. Any day not answered by then is deducted from salary.`,
  };
}
