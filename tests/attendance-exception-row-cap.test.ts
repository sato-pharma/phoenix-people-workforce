import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_ATTENDANCE_EXCEPTION_ROWS,
  fetchAllExceptionRows,
} from "../src/lib/attendance/exceptions.ts";

// ─────────────────────────────────────────────────────────────────────────────
// `getAttendanceExceptions` used to end in `.limit(500)`.
//
// That is the worst shape a cap can take, because a missing attendance exception does not read
// as missing data — it reads as an employee who was absent. An APPROVED exception EXCUSES a day.
// `field-workforce-compliance/head-office-attendance.ts` and
// `field-workforce-compliance/attendance-cross-check.ts` both build their excused-day set
// straight from this array, company-wide across a whole month; the HR command centre and the
// admin exceptions screen read it with `status: "all"` and NO date filter, so they were capped
// against the whole of history. Row 501 onwards quietly became an unexcused absence, and an
// unexcused absence is what a deduction is raised from.
//
// Production held 0 rows when this was fixed (2026-09-22), so nothing had been lost yet. The
// point of this test is that nothing ever is.
//
// What is pinned here is BEHAVIOUR, against a fake client — not the absence of the digits 500
// in the file. Three properties:
//   1. paging runs to exhaustion, however many pages that takes;
//   2. the loop advances by rows RECEIVED, so a server that returns fewer rows than asked for
//      (a PostgREST `max-rows` below the page size) cannot end it early;
//   3. a runaway THROWS rather than returning a short list, because every caller already
//      renders a thrown read as an unavailable source and says so.
// ─────────────────────────────────────────────────────────────────────────────

type FakeRow = { id: number };

/**
 * A stand-in for the Supabase query builder: every builder method returns `this`, and awaiting
 * the object resolves the slice `.range()` asked for. `ranges` records what was requested, so
 * the walk itself can be asserted rather than only its result.
 */
function fakeClient(options: { rows: FakeRow[]; serverMaxRows?: number }) {
  const ranges: Array<[number, number]> = [];
  const orders: string[] = [];
  let limitCalls = 0;

  const builder: Record<string, unknown> = {
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    in: () => builder,
    limit: () => {
      limitCalls += 1;
      return builder;
    },
    order: (column: string) => {
      orders.push(column);
      return builder;
    },
    range: (from: number, to: number) => {
      ranges.push([from, to]);
      const asked = to - from + 1;
      const capped = options.serverMaxRows ? Math.min(asked, options.serverMaxRows) : asked;
      const data = options.rows.slice(from, from + capped);
      // Thenable: `await query` resolves to the PostgREST-shaped envelope.
      return {
        ...builder,
        then: (resolve: (value: { data: FakeRow[]; error: null }) => unknown) =>
          resolve({ data, error: null }),
      };
    },
    select: () => builder,
  };

  return {
    client: { from: () => builder },
    limitCalls: () => limitCalls,
    orders,
    ranges,
  };
}

function rows(count: number): FakeRow[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
}

export async function runAttendanceExceptionRowCapTests() {
  // ── 1. More than 500 rows come back in full ───────────────────────────────
  // THE headline. If this fires, the cap is back and approved exceptions are being dropped.
  const big = fakeClient({ rows: rows(2137) });
  const all = await fetchAllExceptionRows(big.client, (query) => query);
  assert.equal(
    all.length,
    2137,
    "RED every attendance exception must come back — a short list turns an EXCUSED day into an absence, and an absence into a deduction",
  );
  assert.deepEqual(
    all.map((row) => (row as unknown as FakeRow).id).slice(0, 3),
    [1, 2, 3],
    "the first page must still lead the result",
  );
  assert.equal(
    (all[all.length - 1] as unknown as FakeRow).id,
    2137,
    "the LAST row must survive — it is the one a cap eats first",
  );
  assert.equal(big.limitCalls(), 0, "the pager must never call .limit() — that is the defect");

  // ── 2. A short page is not the end of the data ────────────────────────────
  // The server may return fewer rows than requested (PostgREST `max-rows`). A loop that breaks
  // on `page.length < PAGE_SIZE` would stop at 400 of 1,900 here and look perfectly healthy.
  const throttled = fakeClient({ rows: rows(1900), serverMaxRows: 400 });
  const walked = await fetchAllExceptionRows(throttled.client, (query) => query);
  assert.equal(
    walked.length,
    1900,
    "RED a server page smaller than the requested one must not end the walk — the loop advances by rows RECEIVED",
  );
  assert.deepEqual(
    throttled.ranges.map(([from]) => from).slice(0, 4),
    [0, 400, 800, 1200],
    "each request must resume exactly where the previous page actually stopped",
  );

  // ── 3. An empty table is one request and an empty list, not an error ──────
  const none = fakeClient({ rows: [] });
  assert.deepEqual(await fetchAllExceptionRows(none.client, (query) => query), []);
  assert.equal(none.ranges.length, 1, "an empty table must cost exactly one request");

  // ── 4. The sort must be TOTAL, or paging drops and duplicates rows ────────
  // (exception_date, created_at) is not unique: two employees can share both. Without the `id`
  // tiebreak the server is free to order ties differently per page.
  // `orders` accumulates across every request, so compare one request's worth: the same three
  // columns must be re-applied on each page, in the same order.
  assert.deepEqual(
    big.orders.slice(0, 3),
    ["exception_date", "created_at", "id"],
    "paging is only stable on a total sort — keep the id tiebreak",
  );
  assert.equal(
    big.orders.length,
    big.ranges.length * 3,
    "every page must carry the full sort — an unsorted page reshuffles the walk",
  );

  // ── 5. A runaway throws; it never returns a quietly short list ────────────
  const runaway = fakeClient({ rows: rows(MAX_ATTENDANCE_EXCEPTION_ROWS + 5) });
  await assert.rejects(
    () => fetchAllExceptionRows(runaway.client, (query) => query),
    /refusing to answer with a partial list/,
    "RED past the ceiling the read must FAIL loudly — a truncated list is indistinguishable from the truth",
  );

  // ── 6. The service must not reintroduce the cap ───────────────────────────
  // Behaviour above is the real guard; this only catches the obvious rewrite.
  const service = readFileSync(
    new URL("../src/lib/attendance/exceptions.ts", import.meta.url),
    "utf8",
  );
  // Comments are stripped first: the docblocks above the pager deliberately quote the old
  // `.limit(500)` so the next reader knows what was removed and why.
  const code = service
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /\.limit\(\s*\d+\s*\)/,
    "no .limit() belongs in this module — page to completeness instead",
  );
  assert.match(
    service,
    /fetchAllExceptionRows\(supabase, \(query\) => \{/,
    "getAttendanceExceptions must read through the pager",
  );
}
