import type { PayrollPeriod, PriorHold } from "./types.ts";

/**
 * The hold reason — the one durable record of why somebody was not paid.
 *
 * `publishToPayslips` filters `!onHold`, so a held row is DROPPED at publish: no
 * `salary_record` is written, no payslip exists, and nothing anywhere else
 * records that the person was paid outside the system. Everything else about a
 * held employee is recoverable from the run; the reason is not, because nothing
 * generates it. That makes `hold_reason` the only thing standing between the
 * next reviewer and a double payment — July 2026's rows show what it is for
 * ("the SECOND part only is owed; paying full net double-pays part one"), and
 * August 2026's thirteen blank ones show what its absence costs.
 *
 * Two rules live here, and nowhere else:
 *
 *  1. A hold may not be SET without a reason (`assertHoldReasonsPresent`,
 *     enforced in saveStep — the only path a new hold can enter by).
 *  2. A reason inherited from a previous month is LABELLED as inherited
 *     (`formatCarriedForwardReason`), in the stored text rather than in a UI
 *     decoration, so the label survives the save that persists it.
 *
 * Rule 2 exists because the alternative is worse than a blank: a stale note
 * presented as a current assertion gets defended rather than looked up. The
 * prefix travels with the text into `hold_reason`, onto the payroll sheet, and
 * into next month's carry-forward, so a reader is never told "this is why they
 * are held today" when what is meant is "this is why they were held in July".
 *
 * Pure by design — no Supabase, no I/O — so the rules are testable directly and
 * cannot drift into a route handler. The lookup that feeds it lives in
 * draft-store.ts (`listPriorMonthHolds`).
 */

/**
 * What the payroll sheet prints where a reason belongs when a held row has none.
 *
 * It replaces a bare "HOLD", which read as a deliberate status word rather than
 * as missing information: a reviewer scanning the comment column saw a label,
 * not a gap, so the one field that should have stopped them said nothing while
 * looking like it had spoken. Loud on purpose. Unreachable for any hold set
 * after `assertHoldReasonsPresent` landed — it can only ever describe a row
 * held before it, which is exactly the row worth shouting about.
 */
export const HELD_NO_REASON_COMMENT = "HELD — NO REASON RECORDED";

const CARRIED_FORWARD_PREFIX = "Carried forward from ";
const CARRIED_FORWARD_SEPARATOR = " — ";

/** Trim to a real reason, or null. Blank, whitespace and undefined are one case. */
export function normalizeHoldReason(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** True when this text already announces itself as inherited from another month. */
export function isCarriedForwardReason(value: string | null | undefined): boolean {
  return (normalizeHoldReason(value) ?? "").startsWith(CARRIED_FORWARD_PREFIX);
}

/**
 * Strip one carried-forward prefix, returning the underlying reason.
 *
 * Used to re-label rather than nest: a reason that reached July from June and is
 * then carried to August is stored as "Carried forward from July 2026", not as
 * two stacked prefixes. The month named is the one a reader can actually open to
 * check it — the run the text was read from — which is the point of the label.
 */
export function stripCarriedForwardPrefix(value: string): string {
  const reason = normalizeHoldReason(value) ?? "";
  if (!reason.startsWith(CARRIED_FORWARD_PREFIX)) return reason;
  const separatorAt = reason.indexOf(CARRIED_FORWARD_SEPARATOR);
  if (separatorAt < 0) return reason;
  return reason.slice(separatorAt + CARRIED_FORWARD_SEPARATOR.length).trim();
}

/**
 * Label a reason with the month it came from, e.g.
 * "Carried forward from July 2026 — Not paid through this system at all".
 *
 * Returns null for a blank reason: an empty carry-forward would be a prefix with
 * nothing behind it, which asserts a provenance for no content.
 */
export function formatCarriedForwardReason(monthLabel: string, reason: string | null | undefined): string | null {
  const underlying = normalizeHoldReason(reason);
  if (!underlying) return null;
  return `${CARRIED_FORWARD_PREFIX}${monthLabel}${CARRIED_FORWARD_SEPARATOR}${stripCarriedForwardPrefix(underlying)}`;
}

/** The month before `period` — the run a hold reason is inherited from. */
export function previousPeriod(period: PayrollPeriod): PayrollPeriod {
  return period.month <= 1
    ? { month: 12, year: period.year - 1 }
    : { month: period.month - 1, year: period.year };
}

export type { PriorHold };

/**
 * The reason a hold row should DISPLAY, and whether it was inherited.
 *
 * The precedence is the whole rule, in one place so no caller can reorder it:
 *
 *  1. A reason stored for THIS month always wins. Carry-forward fills a gap; it
 *     never overwrites something written for the run being edited, which would
 *     silently replace a current assertion with a stale one.
 *  2. Otherwise, only a HELD row inherits. Carrying a reason onto a row nobody
 *     is holding would attach an explanation to a person being paid normally.
 *  3. The inherited text is labelled with the month it came from, so the
 *     provenance is in the stored string rather than in a UI badge that the
 *     next save would drop.
 *
 * A previous month that held the employee and recorded nothing yields no
 * reason — there is nothing to carry, and inventing one is the failure this
 * module exists to prevent. `priorHold` still surfaces on the row, so the
 * reviewer is told the hold is a continuation even when it was never explained.
 */
export function resolveHoldReason(input: {
  onHold: boolean;
  storedReason: string | null | undefined;
  prior?: PriorHold | null;
  priorMonthLabel: string;
}): { reason: string | null; carriedForward: boolean } {
  const stored = normalizeHoldReason(input.storedReason);
  if (stored) return { reason: stored, carriedForward: false };
  if (!input.onHold) return { reason: null, carriedForward: false };

  const carried = formatCarriedForwardReason(input.priorMonthLabel, input.prior?.reason);
  return carried ? { reason: carried, carriedForward: true } : { reason: null, carriedForward: false };
}

/** A hold as it will stand once this save lands: what the rule is judged against. */
export type HoldReasonCandidate = {
  hrId: string;
  fullName?: string | null;
  onHold: boolean;
  reason: string | null;
};

/**
 * Refuse a save that would leave somebody held with no reason.
 *
 * Judged on the RESULTING state, not on the edit: an edit that turns a hold on
 * passes when a reason is already stored for that person, and an edit that
 * blanks the reason of an already-held row fails — the failure mode is a held
 * row with an empty reason, however it got there.
 *
 * Names the employees rather than counting them, because the caller has to go
 * and type a reason for each and a count does not say for whom. "Validation:"
 * is the prefix `jsonError` maps to HTTP 400.
 */
export function assertHoldReasonsPresent(candidates: HoldReasonCandidate[]): void {
  const missing = candidates.filter(
    (candidate) => candidate.onHold && !normalizeHoldReason(candidate.reason),
  );
  if (missing.length === 0) return;

  const named = missing
    .map((candidate) => {
      const name = normalizeHoldReason(candidate.fullName);
      return name ? `${candidate.hrId} (${name})` : candidate.hrId;
    })
    .join(", ");
  throw new Error(
    `Validation: a hold needs a reason — it is the only record of why someone was not paid, ` +
      `because a held row is dropped at publish and writes no payslip. Add one for: ${named}.`,
  );
}
