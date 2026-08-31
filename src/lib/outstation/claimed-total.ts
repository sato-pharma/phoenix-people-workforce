/**
 * The one reader for "what did this employee claim".
 *
 * A request carries TWO totals. `expected_total_amount` is what the system priced the trip at
 * (travel + ticket + allowance + meeting + other). `claimed_total_amount` is what the submitting
 * client posted. They are normally identical, because the wizard posts the estimate it was just
 * shown — but the client posts `0` whenever the estimate had not resolved at the moment of
 * submit, and until 2026-08-31 the submit path stored that `0` verbatim.
 *
 * A stored `0` is not a claim of nothing. It is the absence of a number, and it renders as
 * "EGP 0 — You claimed" on the employee's own portal card beside a trip that really cost money.
 * That is what request 72 (Menoufia → Cairo, 12 August 2026) showed: claimed 0 against an
 * expected 448.14, with a real 323.14 of fuel behind it.
 *
 * Every consumer that already got this right did the same `> 0 ? claimed : expected` fallback by
 * hand — the payroll mapping, the admin request table, the approval digests. Three surfaces did
 * not, and those three are exactly where the zero was visible. So the fallback lives here once,
 * and the surfaces call it.
 *
 * Note this is a READER, not a repair: it never mutates a row. The submit path now stores the
 * resolved figure so new rows carry a truthful number of their own; this helper is what keeps
 * the rows written before that fix readable.
 */

/**
 * What the employee claimed, in EGP. Falls back to the system's expected total when the stored
 * claim is missing, zero or negative — never returns a bare zero over a real expected total.
 */
export function outstationClaimedTotal(request: {
  claimedTotalAmount?: number | null;
  expectedTotalAmount?: number | null;
}): number {
  const claimed = Number(request.claimedTotalAmount ?? 0);
  if (Number.isFinite(claimed) && claimed > 0) return claimed;
  const expected = Number(request.expectedTotalAmount ?? 0);
  return Number.isFinite(expected) && expected > 0 ? expected : 0;
}
