// The weekly attendance review's rules, as pure functions — no database, no clock — so the tests
// can pin them directly.
//
// Owner decision 2026-09-15, replacing the 2026-09-08 "silent" ruling:
//   • a week waits on the admin review page until the Super Admin releases it — from 2026-09-17 while
//     it is still running, with later days going out in a second release ("Show live, release any time")
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
 * What a settled day's answer IS NOW, after any revision.
 *
 * A settlement is written once per day and never changed (the settle function refuses a second).
 * A disputed day can since be REOPENED and re-decided (owner, 2026-10-09: "Employee asks, reviewer
 * reopens") — phx_attendance_revise_digest_dispute then moves the DAY's own action between
 * dispute_upheld and dispute_rejected, and its chosen method with it. So for a dispute outcome the
 * line is the truth and the settlement is its first draft; for every other answer the settlement
 * stands exactly as it was written. Pure, pinned by tests/dispute-center-digest-revision.test.ts.
 */
export function effectiveSettlement(
  settlement: { action: string; method: string | null | undefined },
  line: { action: string | null | undefined; chosenMethod: string | null | undefined } | null | undefined,
): { action: string; method: string | null; revised: boolean } {
  const isOutcome = (value: string | null | undefined) => value === "dispute_upheld" || value === "dispute_rejected";
  if (isOutcome(settlement.action) && line && isOutcome(line.action) && line.action !== settlement.action) {
    return {
      action: String(line.action),
      method: line.action === "dispute_rejected" ? (isDeductionMethod(line.chosenMethod) ? line.chosenMethod : "salary") : settlement.method ?? null,
      revised: true,
    };
  }
  return { action: settlement.action, method: settlement.method ?? null, revised: false };
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

// ---------------------------------------------------------------------------
// Choosing the days (owner, 2026-09-15 — "I want full control")
// ---------------------------------------------------------------------------
//   • he picks a week of the current payroll month
//   • only the flagged days can be ticked, and every day starts UNTICKED
//   • an unticked day is cleared when the week is released — never deducted
//   • a ticked day's days can be changed, DOWN or UP ("Raise too"), and payroll takes that figure

/** The most a single flagged day can be made to deduct. A typo guard, not a policy: 30 instead of 0.3. */
export const MAX_MARKED_DAYS = 3;

/** The number of days a ticked day deducts, as typed. Rounded to 3 decimals (a digest day can be 0.125). */
export function parseMarkedDays(value: unknown): { days: number; error: null } | { days: null; error: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return { days: null, error: "Enter the number of days to deduct." };
  const days = Math.round(parsed * 1000) / 1000;
  if (days <= 0) return { days: null, error: "A ticked day must deduct more than 0 days. Untick it to clear it instead." };
  if (days > MAX_MARKED_DAYS) return { days: null, error: `One day can deduct at most ${MAX_MARKED_DAYS} days.` };
  return { days, error: null };
}

/**
 * The days payroll must take for a settled day, when the Super Admin changed them before release.
 * `undefined` when he did not — payroll then takes what the month-end fingerprint collector
 * detected, exactly as before. A changed figure is passed even when it is HIGHER than detected
 * (owner: "Raise too"), which is why the bridge also says allowAboveDetected.
 */
export function payrollDaysForSettledLine(line: { deductionDays: number; detectedDays: number | null }): number | undefined {
  if (line.detectedDays === null) return undefined;
  return Math.abs(line.deductionDays - line.detectedDays) < 1e-9 ? undefined : line.deductionDays;
}

/**
 * Whether the Super Admin's figure can replace the month-end deduction's own. Only when the month-end
 * collector detected the same days the weekly review did: otherwise the charge is scaled from a
 * different base, and lowering a day could cost MORE than leaving it (risk review, 2026-09-15). Such a
 * day is left Pending for a person. The collector keeps 2 decimals where a digest day keeps 3.
 */
export function editedDaysApplyToCandidate(input: { detectedDays: number; candidateRawValue: number }): boolean {
  return Number.isFinite(input.candidateRawValue) && Math.abs(input.candidateRawValue - input.detectedDays) < 0.006;
}

/**
 * Which month-end deduction a weekly-review day's answer belongs to. A field day decided in the HR
 * operations report (`field_review`, added by src/lib/hr-ops-reports/bridge.ts) has its own category
 * and is paid through the CRM column; every other day — every fingerprint status, including an office
 * day whose days were set from that report — is a `fingerprint` day, exactly as before.
 */
export function deductionCategoryForDigestLine(status: string | null | undefined): "fingerprint" | "field_review" {
  return status === "field_review" ? "field_review" : "fingerprint";
}

/** The source system that writes the deduction of a field day decided in the HR operations report (bridge.ts). */
export const HR_OPS_REPORT_SOURCE_SYSTEM = "hr_ops_report";

/**
 * The month-end deduction a weekly-review day's answer is applied to: its category, and — for a field
 * day the HR operations report decided — the one writer of it. That day's deduction is written by the
 * bridge (source `hr_ops_report`), so the answer is applied to THAT row. Every other day, an office day
 * whose days the report set included, is looked up exactly as before (`fingerprint`, any source): the
 * month-end Fingerprint connector stays its only writer.
 */
export function deductionSourceForDigestLine(status: string | null | undefined): {
  category: "fingerprint" | "field_review";
  sourceSystem: string | null;
} {
  if (status === "field_review") return { category: "field_review", sourceSystem: HR_OPS_REPORT_SOURCE_SYSTEM };
  return { category: "fingerprint", sourceSystem: null };
}

export type ReviewWeekStage ="not_built" | "trial" | "awaiting_release" | "released" | "closed";

/** Where a week stands, from its digests. A trial-run digest never counts as a real one. */
export function reviewWeekStage(digests: ReadonlyArray<{ status: string; dryRun: boolean }>): ReviewWeekStage {
  if (!digests.length) return "not_built";
  const real = digests.filter((digest) => !digest.dryRun);
  if (!real.length) return "trial";
  if (real.some((digest) => digest.status === "awaiting_release")) return "awaiting_release";
  if (real.some((digest) => digest.status === "open" || digest.status === "settled")) return "released";
  return "closed";
}

/** The week the page opens on: the newest one waiting for release, else the newest released, else the newest. */
export function pickDefaultReviewWeek<T extends { stage: ReviewWeekStage; weekStart: string }>(weeks: readonly T[]): T | null {
  const newestFirst = [...weeks].sort((left, right) => right.weekStart.localeCompare(left.weekStart));
  return (
    newestFirst.find((week) => week.stage === "awaiting_release") ??
    newestFirst.find((week) => week.stage === "released") ??
    newestFirst[0] ??
    null
  );
}

/**
 * Choosing days, building a week and releasing it: the Super Admin ONLY (owner, 2026-09-15 — "i must
 * approve this"). Leaving a day unticked waives a colleague's deduction with nobody else looking, and
 * a release is what notifies every employee, so a named dispute reviewer gets neither.
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
 * How many calendar days the answer window is walked before giving up. Longer than any leave a person
 * can be on, so leave never reaches it; it exists only so a predicate that never says "working"
 * cannot loop forever.
 */
export const ANSWER_WINDOW_MAX_CALENDAR_DAYS = 1000;

/**
 * The last day an employee can still answer: the Nth day AFTER the release date that counts toward
 * the answer window (countsTowardAnswerWindow).
 *
 * Released on a Sunday with 2 working days → Monday and Tuesday are the two days, and the answer
 * is due by the end of Tuesday. The release day itself never counts — a week released at 11pm
 * must not have spent half its window already.
 *
 * If no day in ANSWER_WINDOW_MAX_CALENDAR_DAYS counts, the answer is the last day walked: later than
 * any date the walk could have found, so a broken calendar can only make a deadline more generous,
 * never take salary sooner. Until 2026-09-15 the cap was 60 days and fell back to the plain calendar
 * count — the EARLIEST reading, which a leave longer than the cap would have reached.
 */
export function answerDueDate(input: {
  releasedOnIso: string;
  workingDays: number;
  isWorkingDay: (dateIso: string) => boolean;
}): string {
  const wanted = Math.max(1, Math.floor(input.workingDays));
  let counted = 0;
  let cursor = input.releasedOnIso;
  for (let step = 0; step < ANSWER_WINDOW_MAX_CALENDAR_DAYS; step += 1) {
    cursor = addDaysIso(cursor, 1);
    if (input.isWorkingDay(cursor)) {
      counted += 1;
      if (counted === wanted) return cursor;
    }
  }
  return cursor;
}

/**
 * The leave requests whose days pause the answer window: approved leave (owner, 2026-09-15 — "Pause
 * for leave days"), and leave still waiting for a decision (owner, 2026-09-16 — "Pending pauses
 * too"), so a sick day filed before anyone approves it is not settled to salary while it waits. The
 * waiting statuses are the vacation module's in-flight set (IN_FLIGHT_VACATION_STATUSES in
 * src/lib/vacation/service.ts), and a test holds the two lists together. A rejected or returned
 * request pauses nothing, and a deadline already given or saved is never brought back earlier
 * (heldAnswerDueDate).
 */
export const ANSWER_WINDOW_LEAVE_STATUSES = ["approved", "needs_assignment", "pending_manager", "pending_hr"] as const;

/**
 * Whether a day counts toward the employee's answer window: a day on their own schedule that is
 * neither a public holiday nor a day of leave (ANSWER_WINDOW_LEAVE_STATUSES). Someone on leave is not
 * at work to answer, so the window waits until they are back.
 */
export function countsTowardAnswerWindow(input: {
  isScheduledWorkingDay: boolean;
  isPublicHoliday: boolean;
  onLeave: boolean;
}): boolean {
  return input.isScheduledWorkingDay && !input.isPublicHoliday && !input.onLeave;
}

/**
 * The deadline that holds when it is worked out again: the later of the date the employee was told
 * and the date the answer window gives now. Leave approved after the release moves it later. Nothing
 * moves it earlier — a cancelled leave or a shorter setting never shortens a deadline already given.
 */
export function heldAnswerDueDate(input: { toldDueOn: string | null; recomputedDueOn: string }): string {
  if (!input.toldDueOn) return input.recomputedDueOn;
  return input.recomputedDueOn > input.toldDueOn ? input.recomputedDueOn : input.toldDueOn;
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

/** What decides whether a notice told the employee, beyond the deliveries themselves. */
export type NoticeRecipientFacts = {
  /** An active login that has signed in to Phoenix at least once. */
  hasSignedIn: boolean;
  /** On the employee file, and not resigned, terminated or otherwise gone. */
  stillEmployed: boolean;
};

/** The facts behind NoticeRecipientFacts, as read from the employee file, the login and its sessions. */
export function noticeRecipientFactsFrom(input: {
  /** An employee row was found for the HR id. */
  onEmployeeFile: boolean;
  /** Payroll's leaver rule calls their employment status terminal. */
  terminalStatus: boolean;
  /** An active login exists for the HR id. */
  activeLogin: boolean;
  /** A sign-in session has been recorded for the HR id. */
  hasSession: boolean;
}): NoticeRecipientFacts {
  return {
    hasSignedIn: input.activeLogin && input.hasSession,
    // No employee row at all is not proof they still work here.
    stillEmployed: input.onEmployeeFile && !input.terminalStatus,
  };
}

/** One channel's outcome, as the notification system reports it. */
export type NoticeDelivery = { channel: string; status: string; queuedForRetry?: boolean };

/**
 * Whether a notice reached the employee through a real channel (owner, 2026-09-17 — "Only a real
 * channel"): the email or the Telegram message WENT OUT, or the in-app bell reached someone who has
 * signed in before. Only a delivery that actually happened counts:
 *   - a bell notice for a person who has never signed in tells nobody;
 *   - a channel the notification system skipped or failed tells nobody;
 *   - a message held for quiet hours or waiting for a retry ("pending", "retrying") has not gone out
 *     yet, and some holds can never go out (no linked Telegram, no address);
 *   - an email handed to the outbox to retry is recorded "sent" but did not go out, and the outbox
 *     files permanent blocks (an inactive template, a refused address) under the same retry.
 * Counting too few only leaves days waiting for HR; counting too many deducts salary from someone
 * who was never told.
 */
export function noticeReachedEmployee(
  deliveries: ReadonlyArray<NoticeDelivery>,
  recipient: Pick<NoticeRecipientFacts, "hasSignedIn">,
): boolean {
  return deliveries.some(
    (delivery) =>
      delivery.status === "sent" &&
      !delivery.queuedForRetry &&
      (delivery.channel === "email" || delivery.channel === "telegram" || (delivery.channel === "in_app" && recipient.hasSignedIn)),
  );
}

/**
 * Whether a release notice starts the answer deadline that ends in a salary deduction. Only when it
 * reached the employee through a real channel, and only while they still work here: a leaver still
 * gets the notice, but HR decides their days in the final pay, never the deadline (owner,
 * 2026-09-17, keeping the 2026-09-16 ruling). Anyone not told keeps their days waiting for HR.
 */
export function releaseNoticeReached(
  deliveries: ReadonlyArray<NoticeDelivery>,
  recipient: NoticeRecipientFacts,
): boolean {
  return recipient.stillEmployed && noticeReachedEmployee(deliveries, recipient);
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

// The notices. No amount on either: Telegram is a lock-screen channel, and the amount is one tap away.
function formatShortDay(dateIso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${dateIso}T00:00:00Z`),
  );
}

function formatLongDay(dateIso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${dateIso}T00:00:00Z`),
  );
}

export function buildWeekReleasedMessage(input: { weekStart: string; weekEnd: string; dayCount: number; answerDueOn: string }) {
  const deadline = `Please answer by the end of ${formatLongDay(input.answerDueOn)}. Any day not answered by then is deducted from salary.`;
  // One day reads as that day, "Wednesday 9 September", never "9 Sept to 9 Sept" (owner, 2026-09-17).
  if (input.weekStart === input.weekEnd) {
    const day = formatLongDay(input.weekStart);
    return {
      title: `Attendance review — ${day}`,
      message:
        `Your attendance on ${day} has a deduction.\n\n` +
        `Choose whether the day is deducted from your salary or from your annual vacation balance. ` +
        `After choosing, you can dispute the day if you believe it is wrong.\n\n` +
        deadline,
    };
  }
  const days = input.dayCount === 1 ? "1 day" : `${input.dayCount} days`;
  return {
    title: `Attendance review — ${formatShortDay(input.weekStart)} to ${formatShortDay(input.weekEnd)}`,
    message:
      `Your attendance for ${formatShortDay(input.weekStart)} to ${formatShortDay(input.weekEnd)} has ${days} with a deduction.\n\n` +
      `For each day, choose whether it is deducted from your salary or from your annual vacation balance. ` +
      `After choosing, you can dispute the day if you believe it is wrong.\n\n` +
      deadline,
  };
}

/**
 * The dispute decision notice (owner, 2026-09-15 — "Yes, in-app and Telegram"). Names the day and the
 * outcome and, for a rejected dispute, where the deduction is taken from — with the real cause when
 * annual balance could not be used (disputeSalaryFallbackText). The reviewer's note is not quoted: it
 * is free text on a lock-screen channel, and it is one tap away on the employee's page.
 */
export function buildDisputeDecidedMessage(input: {
  workDate: string;
  upheld: boolean;
  appliedMethod: DeductionMethod | null;
  chosenMethod: DeductionMethod | null;
  balanceRefusal: string | null;
  hasReviewerNote: boolean;
}) {
  const note = input.hasReviewerNote ? " The reviewer left a note on your weekly attendance page." : "";
  if (input.upheld) {
    return {
      title: `Attendance dispute accepted — ${formatShortDay(input.workDate)}`,
      message: `Your dispute for ${formatLongDay(input.workDate)} was accepted. Nothing is deducted for that day.${note}`,
    };
  }
  const outcome =
    input.appliedMethod === "annual_balance"
      ? "The deduction for that day is taken from your annual vacation balance, as you chose."
      : input.chosenMethod === "annual_balance"
        ? disputeSalaryFallbackText(input.balanceRefusal)
        : input.chosenMethod === "salary"
          ? "The deduction for that day is taken from your salary, as you chose."
          : "The deduction for that day is taken from your salary.";
  return {
    title: `Attendance dispute rejected — ${formatShortDay(input.workDate)}`,
    message: `Your dispute for ${formatLongDay(input.workDate)} was rejected. ${outcome}${note}`,
  };
}

/** One day waiting for release as the review page showed it: the line and the days it deducts. */
export type SeenReleaseLine = { id: number; days: number };

/** More days than any real week holds; a longer list is refused rather than read. */
export const MAX_SEEN_RELEASE_LINES = 20_000;

/**
 * The days the page showed when Release was clicked, from the request body. Every entry must be a
 * positive whole line id and a finite number of days; nothing is guessed or skipped, because the list is
 * what proves the Super Admin saw every day he is releasing.
 */
export function parseSeenReleaseLines(value: unknown): { lines: SeenReleaseLine[]; error: null } | { lines: null; error: string } {
  if (!Array.isArray(value)) return { lines: null, error: "Reload the page and release again: the days you saw were not sent." };
  if (value.length > MAX_SEEN_RELEASE_LINES) return { lines: null, error: "Too many days were sent." };
  const lines: SeenReleaseLine[] = [];
  for (const entry of value) {
    const id = Number((entry as { id?: unknown } | null)?.id);
    const days = Number((entry as { days?: unknown } | null)?.days);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(days) || days < 0) {
      return { lines: null, error: "Reload the page and release again: a day you saw could not be read." };
    }
    lines.push({ id, days });
  }
  return { lines, error: null };
}

/**
 * Which employee a release is for, from the request body (owner, 2026-09-17 — "every row has a release
 * beside it … so I can release one employee and after release another"). Absent means the whole week:
 * every employee waiting. Present, it must be a positive whole digest id; anything else is refused rather
 * than read as "everyone", which would tell and clear people the Super Admin did not pick.
 */
export function parseReleaseDigestId(value: unknown): { digestId: number | null; error: null } | { digestId: null; error: string } {
  if (value === undefined || value === null) return { digestId: null, error: null };
  const digestId = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(digestId) || digestId <= 0) {
    return { digestId: null, error: "Reload the page and release again: the employee you picked could not be read." };
  }
  return { digestId, error: null };
}

/**
 * The waiting digests one release covers: every one in the week, or only the picked employee's. The
 * others are not touched — their unticked days are not cleared and nobody else is told — so they keep
 * waiting for their own release.
 */
export function releaseScope<T extends { id: number }>(waiting: readonly T[], digestId: number | null): T[] {
  return digestId === null ? [...waiting] : waiting.filter((digest) => digest.id === digestId);
}

/**
 * The days waiting for release that the page did NOT show as they are now: added since it loaded, or
 * with different days (owner, 2026-09-17 — release any time, while the daily job keeps adding days). Any
 * one of them means the Super Admin would release something he never saw, so the release is refused.
 * Days are compared at 3 decimals, as they are stored. The database function repeats this check under
 * the week's row lock.
 */
export function staleReleaseLines(
  pending: ReadonlyArray<{ id: number; deductionDays: number }>,
  seen: readonly SeenReleaseLine[],
): number[] {
  const seenDays = new Map(seen.map((line) => [line.id, Math.round(line.days * 1000)]));
  return pending.filter((line) => seenDays.get(line.id) !== Math.round(line.deductionDays * 1000)).map((line) => line.id);
}

/**
 * The dates a release notice names: the first and last day actually asked about. A second release of a
 * week covers only the days that arrived after the first, so it must not repeat the whole week's dates.
 * Falls back to the week when no day is listed.
 */
export function releaseNoticeRange(
  askedDays: ReadonlyArray<{ workDate: string }>,
  week: { weekStart: string; weekEnd: string },
): { weekStart: string; weekEnd: string } {
  if (!askedDays.length) return { weekStart: week.weekStart, weekEnd: week.weekEnd };
  const dates = askedDays.map((day) => day.workDate).sort();
  return { weekStart: dates[0]!, weekEnd: dates[dates.length - 1]! };
}
