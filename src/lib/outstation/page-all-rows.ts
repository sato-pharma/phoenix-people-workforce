/**
 * Reading every row out of PostgREST, when "every" can exceed 1,000.
 *
 * PostgREST answers at most 1,000 rows per request and gives NO marker when it truncates — the
 * 1,001st row simply is not there, with no error, no count and nothing in the response to say the
 * answer is partial. A single unbounded `.select()` is therefore a silent cap, not a full read.
 *
 * This is not hypothetical in this codebase: `loadPayoutExpenseTrips` in
 * `automated-payroll/recommend.ts` was rewritten for exactly this reason and carries the same note.
 * That fix stopped at the payroll wizard, and the reads behind the Expense Approvals queue and the
 * payroll template pre-fill kept the unbounded form until 2026-09-08. `outstation_expenses` held
 * 374 rows that day, so nothing was being lost yet — which is the whole argument for fixing it
 * before the cap is reached rather than after. Past 1,000 the failure has no symptom of its own:
 * the queue just looks short, and the pre-fill just pays less.
 *
 * EVERY PAGED READ NEEDS A TOTAL ORDER, not merely an order. `expense_date` and `created_at` both
 * repeat — a whole team's trips share a day — and PostgREST resolves ties however the query plan
 * happens to return them, which is not stable between requests. Two pages of a non-unique sort can
 * therefore drop one row and repeat another: a subtler version of the very bug being fixed. Every
 * caller must add a unique column (`id`) as a final tiebreaker.
 *
 * Deliberately imports NOTHING. It is used from modules that construct a Supabase admin client at
 * import time, and a test must be able to exercise the paging logic without dragging that in — the
 * same reason `claims-read-flag.ts` is kept bare.
 */

/** PostgREST's own default ceiling. Paging in units of the cap keeps the row maths obvious. */
export const POSTGREST_PAGE_SIZE = 1000;

/**
 * Calls `buildPage` for successive row windows until a short page comes back, collecting the lot.
 *
 * Returns the same `{ data, error }` shape a single PostgREST call returns, so a caller keeps its
 * existing error handling verbatim — several callers translate a missing-schema error into an empty
 * list rather than throwing, and that behaviour must not change just because the read is paged now.
 *
 * On an error part-way through, the rows gathered so far are returned ALONGSIDE the error rather
 * than being discarded. Every caller checks `error` first, so a partial read can never be mistaken
 * for a complete one; returning both simply keeps the shape honest instead of pretending a failed
 * read found nothing.
 *
 * `buildPage` must build a FRESH query each call: a PostgREST builder is consumed once awaited.
 */
export async function fetchAllRows<T, E>(
  buildPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>,
  pageSize: number = POSTGREST_PAGE_SIZE,
): Promise<{ data: T[]; error: E | null }> {
  const collected: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) return { data: collected, error };

    const rows = data ?? [];
    collected.push(...rows);

    // A short page is the only reliable end signal. Asking PostgREST for an exact count instead
    // would cost a second full scan on every load of the approvals queue, and a count taken
    // separately from the read can disagree with it under concurrent writes anyway.
    //
    // The cost of this rule is one extra empty request when the total is an exact multiple of the
    // page size. That is the correct trade: the alternative — stopping on a full page — is what
    // truncation looks like, which is the bug.
    if (rows.length < pageSize) break;
  }

  return { data: collected, error: null };
}
