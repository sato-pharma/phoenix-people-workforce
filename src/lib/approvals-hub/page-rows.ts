/**
 * Read every row a filtered approvals-hub query matches, instead of the first N.
 *
 * WHY THIS EXISTS. The hub's company-wide feeds each ended in a `.limit()` — 400, 500 or 1000
 * depending on the surface. A capped read is the worst kind of wrong answer: it returns a
 * well-formed list that is simply missing rows, and nothing on the page says so. On an approvals
 * surface that means a request that was decided, or is waiting to be decided, silently does not
 * exist for the person looking at it.
 *
 * It was not hypothetical. Measured on production 2026-09-23: the company-wide leave decision
 * history matched 536 decided requests against `.limit(500)` — 36 real decisions, the oldest back
 * to 2026-06-30, were already being dropped from what Super Admin was shown.
 *
 * HOW IT PAGES.
 *
 * The offset advances by the number of rows RECEIVED, never by the page size. PostgREST can be
 * configured with a `max-rows` below our page size, and a walk that assumed a full page would then
 * skip everything past the server's own ceiling on the very first step. Advancing by what actually
 * came back costs one extra empty request at the true end, which is the right price for never
 * shortening the list by accident.
 *
 * EVERY CALLER MUST ORDER BY A TOTAL SORT. Paging is only stable if the ordering is total, and the
 * hub's natural sort keys are not: two people can hold the same `decided_at`, `submitted_at` or
 * `created_at` instant, and an order that wobbles between pages both drops and duplicates rows.
 * Each call site therefore ends its `.order()` chain with `id`, which is unique on all four tables
 * these feeds read.
 *
 * FAIL LOUD, NOT SHORT. Past MAX_APPROVALS_HUB_ROWS the read returns an `error` rather than the
 * rows gathered so far. Every caller already renders a failed read as an unavailable source, and a
 * surface that says it could not load is honest in a way that a quietly truncated one is not.
 *
 * It takes a query FACTORY rather than a query, because a PostgREST builder is single-use — each
 * page needs a fresh one. That also lets `tests/approvals-hub-row-cap.test.ts` drive the paging
 * rule against a fake client, instead of pinning it with a regex that would pass the day someone
 * reintroduced a `.limit()` two lines away.
 */

/** Rows per request. Comfortably under PostgREST's default ceiling, and one request for most feeds. */
export const APPROVALS_PAGE_SIZE = 1000;

/**
 * The point past which we refuse to answer at all. Far above anything these tables hold (the
 * largest matched 536 rows when this was written), so reaching it means something is wrong with
 * the filter, not with the data.
 */
export const MAX_APPROVALS_HUB_ROWS = 100_000;

type Postgrestish = {
  data: unknown[] | null;
  error: unknown;
};

export async function fetchAllApprovalRows<T>(
  // A PostgREST builder is not usefully typed here without dragging the generated database types
  // through every call site; the shape that matters ({ data, error }, .range()) is asserted below.
  buildQuery: () => any, // eslint-disable-line @typescript-eslint/no-explicit-any
  options?: { maxRows?: number; pageSize?: number },
): Promise<{ data: T[] | null; error: unknown }> {
  const pageSize = options?.pageSize ?? APPROVALS_PAGE_SIZE;
  const maxRows = options?.maxRows ?? MAX_APPROVALS_HUB_ROWS;
  const rows: T[] = [];

  for (let offset = 0; ; ) {
    const { data, error } = (await buildQuery().range(offset, offset + pageSize - 1)) as Postgrestish;
    if (error) return { data: null, error };

    const page = (data ?? []) as T[];
    if (page.length === 0) break;

    rows.push(...page);
    // By rows RECEIVED — see the note above on a server-side max-rows below our page size.
    offset += page.length;

    if (rows.length > maxRows) {
      return {
        data: null,
        error: new Error(
          `Approvals hub read exceeded ${maxRows} rows; refusing to answer with a partial list.`,
        ),
      };
    }
  }

  return { data: rows, error: null };
}
