/**
 * MONEY ADDED TO A PAYSLIP SAYS WHY.
 *
 * Additions is the only step in the wizard that ADDS money, and it is the only one whose figures
 * have no feeder behind them. Every other money step is pre-filled from somewhere a reader can go
 * and check: the Deductions module, the expense workflow, the CRM, the vacation ledger. Incentive,
 * bonus and overtime are typed, and until now they were typed into a grid with no source, no
 * reason, no upper limit and no expandable breakdown. A 50,000 EGP bonus against one employee was
 * accepted by the grid, by the route and by the pre-flight validator, and reached the payslip.
 *
 * The audit trail did not catch it either, and that is the half worth understanding. `summarizeStep`
 * totalled the FIRST field it found, which on this step is Incentive — so bonus and overtime left
 * no trace in any audit entry at all. Measured on the August run: the audit recorded an incentive
 * total of 5,442 across 120 employees, while the same rows also carried 2,258.00 of bonus and
 * 1,000.00 of overtime that no audit row mentioned.
 *
 * SO THE REASON IS NOT DECORATION — it is the only thing that will ever explain one of these
 * figures to somebody reading the month back. A deduction can be traced to its detector; an
 * addition can only be traced to whoever asked for it.
 *
 * ENFORCED AT CONFIRM, not at save. Confirming is what locks the step, and Part 2 confirm refuses
 * unless every step is confirmed — so there is no route to a published addition that does not pass
 * through here. Judged on the resulting state rather than on the edit, the same way a hold is: the
 * failure is a paid addition with no reason, however it got there.
 *
 * Pure by design, like hold-reason.ts — no Supabase, no I/O — so the rule is testable directly and
 * cannot drift into a route handler.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: cap the amount. The audit asked for an upper limit too, and a
 * limit is a number only the owner can give. Refusing an addition over a figure invented here would
 * block a legitimate payment on a threshold nobody agreed.
 */

/** Trim to a real reason, or null. Blank, whitespace and undefined are one case. */
export function normalizeAdditionsReason(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** An addition as it will stand once this confirm lands: what the rule is judged against. */
export type AdditionsReasonCandidate = {
  hrId: string;
  fullName?: string | null;
  /** Incentive + bonus + overtime + other additions, as the step is about to persist them. */
  total: number;
  reason: string | null;
};

// Other additions too (2026-10-09): a dispute refund is money added to a payslip like any other, and
// its recommended reason travels with it, so a confirmed refund never stands unexplained.
const MONEY_FIELDS = ["incentive", "bonus", "overtime", "otherAdditions"] as const;

/**
 * The candidates a confirmation is judged on: the rows it is about to persist, and only those.
 *
 * `readOnly` rows are dropped because `confirmStep` drops them too — an informational row is
 * rendered but never written, so holding the step open over one would block on a reason no row
 * would ever store.
 */
export function additionsCandidatesFromStepRows(
  rows: ReadonlyArray<{
    hrId: string;
    fullName?: string | null;
    values?: Record<string, number | null | undefined>;
    reason?: string | null;
    readOnly?: boolean;
  }>,
): AdditionsReasonCandidate[] {
  return rows
    .filter((row) => !row.readOnly)
    .map((row) => {
      let total = 0;
      for (const field of MONEY_FIELDS) {
        const value = Number(row.values?.[field] ?? 0);
        if (Number.isFinite(value)) total += value;
      }
      return {
        hrId: row.hrId,
        fullName: row.fullName ?? null,
        total: Math.round(total * 100) / 100,
        reason: row.reason ?? null,
      };
    });
}

/**
 * Refuse a confirm that would pay somebody an addition nobody explained.
 *
 * Zero is not an addition, so a row left at 0 needs nothing — which is most of the sheet. Names the
 * employees and the amounts rather than counting them: the caller has to go and type a reason for
 * each, and a count says neither for whom nor how much. "Validation:" is the prefix `jsonError`
 * maps to HTTP 400.
 */
export function assertAdditionsReasonsPresent(candidates: AdditionsReasonCandidate[]): void {
  const missing = candidates.filter(
    (candidate) => candidate.total > 0 && !normalizeAdditionsReason(candidate.reason),
  );
  if (missing.length === 0) return;

  const named = missing
    .slice(0, 8)
    .map((candidate) => {
      const name = normalizeAdditionsReason(candidate.fullName);
      const who = name ? `${candidate.hrId} (${name})` : candidate.hrId;
      return `${who}: ${candidate.total.toFixed(2)}`;
    })
    .join(", ");
  const rest = missing.length > 8 ? `, and ${missing.length - 8} more` : "";
  throw new Error(
    "Validation: money added to a payslip needs a reason. This is the only step with no feeder " +
      "behind it, so the reason is the only thing that will ever explain the figure to whoever " +
      `reads the month back. Add one for: ${named}${rest}.`,
  );
}
