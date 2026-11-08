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
  /**
   * Ask for this many pages at once, in waves, instead of one after another (2026-11-08, Place checks:
   * six pages of active places one by one were four of its seconds). The rows, their order, the empty-page
   * end and the ceiling are exactly the sequential walk's — see `readEveryPage`. Leave it unset for a
   * read whose rows are mostly past the first page anyway, or that runs on a table being written in bulk.
   */
  concurrentPages?: number;
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

  let offset = 0;
  // 🔴 WAVES, WHEN ASKED FOR — AND ONLY FULL PAGES ARE TRUSTED IN THEM. A wave asks for the next N pages at
  // their page-size offsets at once. While every page comes back full, those offsets were right. The first
  // short or empty page ends the waves: if every later page of that wave is empty, the walk carries on
  // ONE PAGE AT A TIME from the rows actually received (the loop below), so the end is still proven by an
  // empty page; if a later page holds rows, the server's ceiling is below the page size and the offsets
  // were wrong, so everything is thrown away and the walk starts again one page at a time.
  const waves = Math.max(1, Math.floor(options.concurrentPages ?? 1));
  const received: T[] = [];
  let ended = false;
  if (waves > 1) {
    wave: for (;;) {
      const offsets: number[] = [];
      for (let index = 0; index < waves && offset + index * pageSize <= maxRows; index += 1) offsets.push(offset + index * pageSize);
      if (offsets.length === 0) break;
      const answers = (await Promise.all(
        offsets.map((from) => buildQuery().range(from, Math.min(from + pageSize - 1, maxRows))),
      )) as { data: unknown; error: unknown }[];
      for (let index = 0; index < answers.length; index += 1) {
        const { data, error } = answers[index];
        if (error) return { rows: [], error, capped: false };
        const page = (Array.isArray(data) ? data : []) as T[];
        const asked = Math.min(offsets[index] + pageSize - 1, maxRows) - offsets[index] + 1;
        received.push(...page);
        offset = offsets[index] + page.length;
        if (page.length < asked) {
          const later = answers.slice(index + 1);
          if (later.some((answer) => answer.error || (Array.isArray(answer.data) && answer.data.length > 0))) {
            received.length = 0;
            offset = 0;
          } else if (page.length === 0) {
            ended = true;
          }
          break wave;
        }
      }
    }
    for (const row of received) {
      if (options.uniqueBy) {
        const key = options.uniqueBy(row);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }
    // The waves alone reached the ceiling: the same two answers the loop below gives.
    if (offset > maxRows) return pastCeiling(rows, maxRows, options);
  }

  for (; !ended && offset <= maxRows; ) {
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

    if (offset > maxRows) return pastCeiling(rows, maxRows, options);
  }

  return { rows, error: null, capped: false };
}

function pastCeiling<T>(rows: T[], maxRows: number, options: PagedReadOptions<T>): PagedRead<T> {
  if (options.whenFull === "stop") return { rows: rows.slice(0, maxRows), error: null, capped: true };
  return {
    rows: [],
    error: new Error(`${options.what} came to more than ${maxRows.toLocaleString("en-US")} rows; refusing to answer with part of them.`),
    capped: true,
  };
}
