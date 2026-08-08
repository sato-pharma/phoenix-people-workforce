/**
 * The duplicate-day allowance guard: one employee earns at most one allowance per calendar
 * day, no matter how many separate outstation_expense_requests rows touch that day.
 *
 * Owner-reported bug (2026-08-08): an employee submitted a trip, then separately tried to log
 * a same-day meeting invoice with its own invoice attachment, and noticed the meeting entry
 * would carry a SECOND full day's allowance for a date already paid by the trip. He stopped and
 * flagged it. The owner hit the identical duplication on the very next manual expense he tried
 * to create for that employee. The root cause: allowance was computed by a pure function of
 * (tripStartDate, tripEndDate, policy) alone, called independently from four different write
 * paths, none of which had any idea a sibling request already covered part of the span.
 *
 * Every allowance calculation in service.ts goes through this guard now — see
 * calculateGuardedAllowanceBreakdown there, the sole entry point.
 *
 * Pure and synchronous on purpose, the same discipline expense-gate.ts uses for the payroll
 * gate: this decides whether real money is paid twice for one day, so it must be assertable
 * without a database. The Supabase read that feeds it lives in service.ts; only the day-overlap
 * MATH lives here.
 */

/**
 * `iso` shifted forward by `days` whole UTC calendar days, as YYYY-MM-DD.
 *
 * Deliberately self-contained rather than importing service.ts's own day-math: that would wire
 * this pure module back into the DB-heavy service file it exists to stay separate from, for a
 * five-line utility. The duplication is intentional, not an oversight — `wholeUtcDaysBetween`
 * below and this function must agree with EACH OTHER, not with service.ts's copy, because they
 * describe one shared day-index between them: `wholeUtcDaysBetween` counts how many of these
 * steps sit between two dates, and this function names the calendar date AT a given step.
 */
function addUtcDays(iso: string, days: number): string {
  const start = new Date(iso);
  const shifted = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + days),
  );
  return shifted.toISOString().slice(0, 10);
}

function wholeUtcDaysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.round((endUtc - startUtc) / 86400000));
}

/** One request's allowance span, as read from the database. */
export type AllowanceClaimingRequest = {
  id: number;
  status: string;
  tripEndDate: string;
  tripStartDate: string;
};

/**
 * Statuses that never hold a day. Once a request is refused, whatever it would have paid was
 * never real, and letting a rejected request block a later legitimate claim on the same date
 * would strand pay for no reason. Everything else that has ever priced a real allowance —
 * submitted, accepted, approved, still awaiting a decision — counts: the money is provisionally
 * spoken for the moment it is calculated and stored, not only once someone signs off on it.
 */
const NON_CLAIMING_STATUSES = new Set(["rejected_by_system", "rejected_by_admin"]);

/**
 * Every calendar day claimed by the given requests, mapped to the id of the request that
 * claims it.
 *
 * `excludeRequestId` is the request being priced RIGHT NOW — on an edit, a request must never
 * be told its own previously-claimed days are already taken by someone else.
 *
 * When two requests both touch a day, the LOWEST id wins: the first one ever created for that
 * date. Deterministic regardless of the order `requests` arrives in — the input is sorted here,
 * not assumed pre-sorted, so a caller cannot silently change who wins a contested day by
 * changing its own query order.
 */
export function deriveClaimedAllowanceDays(
  requests: AllowanceClaimingRequest[],
  excludeRequestId?: number,
): Map<string, number> {
  const claimed = new Map<string, number>();
  const ordered = [...requests].sort((a, b) => a.id - b.id);

  for (const request of ordered) {
    if (excludeRequestId != null && request.id === excludeRequestId) continue;
    if (NON_CLAIMING_STATUSES.has(request.status)) continue;

    const span = wholeUtcDaysBetween(request.tripStartDate, request.tripEndDate);
    for (let index = 0; index <= span; index += 1) {
      const day = addUtcDays(request.tripStartDate, index);
      if (!claimed.has(day)) claimed.set(day, request.id);
    }
  }

  return claimed;
}

/**
 * The calendar date each row of a trip's allowance breakdown corresponds to, in order.
 *
 * Row i (0-indexed) is always tripStartDate + i days — true whether the trip is a single
 * same-day row, N overnight rows, or N overnight rows plus one return-day row, because
 * calculateRawAllowanceBreakdown in service.ts always emits exactly one row per calendar day
 * of the span, in date order. This function and that one must stay in agreement; if the raw
 * breakdown's row-per-day shape ever changes, this must change with it.
 */
export function allowanceRowDates(tripStartDate: string, rowCount: number): string[] {
  return Array.from({ length: rowCount }, (_, index) => addUtcDays(tripStartDate, index));
}
