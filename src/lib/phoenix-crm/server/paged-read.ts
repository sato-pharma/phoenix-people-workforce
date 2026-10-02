/**
 * Phoenix CRM — reading every row a query matches, past PostgREST's 1,000-row ceiling.
 *
 * No I/O of its own: it is handed a query FACTORY and only ever calls `.range()` on what that returns.
 * A PostgREST builder is single-use, so each page needs a fresh one — and a factory is also what lets
 * `tests/phoenix-crm-sweep-paging.test.ts` drive the real reads against a fake that stops at 1,000 rows
 * exactly as the live server does.
 *
 * ## 🔴 WHY `.limit(N)` ABOVE 1,000 DOES NOTHING
 *
 * PostgREST answers every request with at most `max-rows` rows — 1,000 on this project — and says
 * nothing when it stops: no error, no marker, a well-formed list that is simply short. `.limit()` can
 * only ask for FEWER rows than that ceiling, never more. Two reads in the nightly sweep ended in
 * `.limit(50_000)` and `.limit(20_000)`, so both were judging their first 1,000 rows as the whole
 * (Phoenix CRM audit, 2026-10-02):
 *
 *   - the behaviour pass read a month's visits in capture order, so it judged the FIRST ~1,000 visits
 *     of the month company-wide and never saw the rest — Delta (1) alone makes ~3,700 a month;
 *   - the photo comparison read its corpus newest first, so a new photo was compared only with the
 *     newest 1,000 fingerprints, and a picture re-used from a few weeks back was never seen.
 *
 * ## How it pages — the approvals hub's pager (`src/lib/approvals-hub/page-rows.ts`), with a ceiling
 *
 * - `.range()` in pages of 1,000, the offset advancing by rows RECEIVED, never by the page size: a
 *   server whose own ceiling sat below the page size would otherwise skip everything past it.
 * - It ends on an EMPTY page, never on a short one, for the same reason. One extra request at the true
 *   end is the price of never stopping early.
 * - EVERY CALLER ORDERS BY A TOTAL SORT — its own key, then a unique column. An order that wobbles
 *   between pages both drops rows and repeats them.
 * - `uniqueBy` keeps a row the walk met twice ONCE. An offset walk over a table written while it reads
 *   (a visit synced late, carrying an earlier capture time) shifts every later page by one and repeats
 *   the row at the seam. A visit read twice is two captures in the same second — exactly the shape the
 *   behaviour rules look for — so a repeat here is not untidy, it is evidence nobody produced.
 *
 * ## The ceiling, and the two answers to reaching it
 *
 * Each read keeps its own maximum, so one night can never pull a table into memory. The walk asks for
 * ONE row past it — enough to know there is more, never a page of it — and then answers as told:
 *
 * - `"refuse"`: no rows and an error. For a read that JUDGES. A month judged on part of itself is a
 *   verdict about visits nobody read, so the night fails loudly instead, and the cron's dead-man's
 *   switch records a night that did not run.
 * - `"stop"`: the first `maxRows` in the caller's own order, and `capped: true`. For a read whose
 *   order puts what matters first and whose ceiling is a bound on memory — the photo corpus is newest
 *   first, so at the ceiling the comparison simply looks back less far: a missed catch, never a false one.
 *
 * Why not import the approvals hub's pager: it belongs to another module, it has no `"stop"` and no
 * `uniqueBy`, and its refusal names the approvals hub. The rule is the same; the reasons differ.
 */

/** Rows per request — PostgREST's own ceiling on this project, so one request is one full page. */
export const PHOENIX_CRM_PAGE_SIZE = 1_000;

export type PagedRead<T> = {
  /** Every row, in the caller's order. Empty whenever `error` is set — never a partial answer. */
  rows: T[];
  error: unknown;
  /** True when the read reached its ceiling: refused (no rows) or stopped there (rows cut). */
  capped: boolean;
};

export type PagedReadOptions<T> = {
  /** The most rows the read may hold. The walk reads one past it, to know whether there is more. */
  maxRows: number;
  /** What to do past `maxRows` — see the header. */
  whenFull: "refuse" | "stop";
  /** What is being read, in words, for the error a refusal carries. */
  what: string;
  /** A row's identity. A row the walk meets a second time is kept once. */
  uniqueBy?: (row: T) => string;
  pageSize?: number;
};

export async function readEveryPage<T>(
  // A PostgREST builder is not usefully typed here without dragging the generated database types
  // through every caller; the shape that matters ({ data, error }, `.range()`) is asserted below.
  buildQuery: () => any, // eslint-disable-line @typescript-eslint/no-explicit-any
  options: PagedReadOptions<T>,
): Promise<PagedRead<T>> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? PHOENIX_CRM_PAGE_SIZE));
  const maxRows = Math.max(0, Math.floor(options.maxRows));
  const rows: T[] = [];
  const seen = new Set<string>();

  for (let offset = 0; ; ) {
    // Never further than one row past the ceiling: that row answers "is there more?", and a page of
    // rows beyond it would only be read to be thrown away.
    const last = Math.min(offset + pageSize - 1, maxRows);
    const { data, error } = (await buildQuery().range(offset, last)) as { data: unknown; error: unknown };
    // A failed page is an error, never the end of the data — a short list that reads as complete is
    // the whole defect this file exists for.
    if (error) return { rows: [], error, capped: false };

    const page = (Array.isArray(data) ? data : []) as T[];
    if (page.length === 0) break;
    // By rows RECEIVED — see the header on a server ceiling below the page size.
    offset += page.length;

    for (const row of page) {
      if (options.uniqueBy) {
        const key = options.uniqueBy(row);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }

    if (offset > maxRows) {
      if (options.whenFull === "stop") return { rows: rows.slice(0, maxRows), error: null, capped: true };
      return {
        rows: [],
        error: new Error(
          `${options.what} came to more than ${maxRows.toLocaleString("en-US")} rows; refusing to answer with part of them.`,
        ),
        capped: true,
      };
    }
  }

  return { rows, error: null, capped: false };
}
