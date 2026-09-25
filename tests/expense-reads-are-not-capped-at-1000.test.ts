import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fetchAllRows, POSTGREST_PAGE_SIZE } from "../src/lib/outstation/page-all-rows.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Every expense read must page, because PostgREST's 1,000-row ceiling has NO symptom.
 *
 * A single unbounded `.select()` returns at most 1,000 rows and says nothing about the ones it
 * dropped: no error, no count, no flag on the response. So the failure never presents as a failure.
 * On the Expense Approvals queue it presents as "some expenses aren't showing"; on the payroll
 * template pre-fill it presents as people being reimbursed less than they claimed; on the report
 * lock it presents as a paid report becoming deletable.
 *
 * `loadPayoutExpenseTrips` in automated-payroll/recommend.ts was already rewritten for exactly this
 * reason and carries a comment saying so — but that fix stopped at the payroll wizard, and the six
 * reads in `outstation/expenses.ts` kept the unbounded form until 2026-09-08. `outstation_expenses`
 * held 374 rows that day, so nothing had been lost yet. That is the argument for the fix, not
 * against it: below the cap the correct and the broken versions are indistinguishable.
 *
 * The helper's own behaviour is executed for real below against a fake page source. The six call
 * sites are pinned against source, because a correct helper nothing calls is the same bug.
 */

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** A page source over a fixed row set, counting the requests it serves. */
function pageSourceOf(totalRows: number, pageSize: number) {
  const all = Array.from({ length: totalRows }, (_, index) => ({ id: index }));
  const windows: Array<[number, number]> = [];
  return {
    all,
    windows,
    build(from: number, to: number) {
      windows.push([from, to]);
      return Promise.resolve({ data: all.slice(from, to + 1), error: null });
    },
    pageSize,
  };
}

export async function runExpenseReadsAreNotCappedAt1000Tests() {
  // ── The helper ─────────────────────────────────────────────────────────────────────────────

  assert.equal(POSTGREST_PAGE_SIZE, 1000, "the page size must match PostgREST's own ceiling");

  // A page size of 10 keeps these readable; the logic is identical at 1,000.
  const PAGE = 10;

  // THE HEADLINE. More rows than one page holds: every row must come back, not the first page.
  const many = pageSourceOf(25, PAGE);
  const manyResult = await fetchAllRows(many.build, PAGE);
  assert.equal(manyResult.error, null);
  assert.equal(
    manyResult.data.length,
    25,
    "a read spanning three pages must return all 25 rows — returning 10 is the bug this exists to stop",
  );
  assert.deepEqual(
    manyResult.data.map((row) => row.id),
    Array.from({ length: 25 }, (_, index) => index),
    "and in order, with nothing dropped or repeated across the page boundaries",
  );
  assert.deepEqual(
    many.windows,
    [[0, 9], [10, 19], [20, 29]],
    "windows must advance by exactly one page and be inclusive at both ends, the way .range() is",
  );

  // THE BOUNDARY THAT LOOKS LIKE COMPLETION. When the total is an exact multiple of the page size,
  // the last full page is indistinguishable from a truncated one — the only way to know is to ask
  // for one more. Stopping on a full page is precisely what a capped read does.
  const exact = pageSourceOf(20, PAGE);
  const exactResult = await fetchAllRows(exact.build, PAGE);
  assert.equal(exactResult.data.length, 20, "an exact multiple of the page size must return every row");
  assert.equal(
    exact.windows.length,
    3,
    "and must cost one extra empty request to prove there is no more — a full page is never an end signal",
  );

  // A single short page is the ordinary case and must cost exactly one request.
  const few = pageSourceOf(4, PAGE);
  const fewResult = await fetchAllRows(few.build, PAGE);
  assert.equal(fewResult.data.length, 4);
  assert.equal(few.windows.length, 1, "a short first page ends the read immediately");

  // Empty is not an error.
  const none = pageSourceOf(0, PAGE);
  const noneResult = await fetchAllRows(none.build, PAGE);
  assert.deepEqual(noneResult.data, []);
  assert.equal(noneResult.error, null);

  // An error must surface, and must NOT be dressed up as a complete read. Callers check `error`
  // first — several of them turn a missing-schema error into an empty list rather than throwing,
  // and that behaviour has to survive the read becoming paged.
  let calls = 0;
  const failing = await fetchAllRows<{ id: number }, { message: string }>((from, to) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({ data: Array.from({ length: PAGE }, (_, i) => ({ id: from + i })), error: null });
    }
    return Promise.resolve({ data: null, error: { message: "schema cache miss" } });
  }, PAGE);
  assert.equal(failing.error?.message, "schema cache miss", "the error must reach the caller");
  assert.equal(calls, 2, "and must stop the loop rather than spinning");
  assert.equal(
    failing.data.length,
    PAGE,
    "rows already gathered come back beside the error — the caller checks error first, so this " +
      "cannot be mistaken for a complete read",
  );

  // A null data page with no error ends the read rather than looping forever.
  const nullPage = await fetchAllRows<{ id: number }, { message: string }>(
    () => Promise.resolve({ data: null, error: null }),
    PAGE,
  );
  assert.deepEqual(nullPage.data, []);
  assert.equal(nullPage.error, null);

  // ── The call sites ─────────────────────────────────────────────────────────────────────────

  const expenses = readSource("../src/lib/outstation/expenses.ts");

  // Six reads, each of which can grow past the cap.
  assert.ok(
    (expenses.match(/fetchAllRows\(/g) ?? []).length >= 6,
    "every unbounded read on the expense tables must go through the paging helper",
  );

  // Named individually so a future edit that un-pages one of them fails with the reason attached,
  // rather than merely dropping a count.
  for (const [label, marker] of [
    ["the Expense Approvals queue (imported rows)", 'expense_date", { ascending: false }'],
    ["the Expense Approvals queue (app-submitted rows)", 'created_at", { ascending: false }'],
    ["the payroll template pre-fill", '.eq("hr_approved", true)'],
  ] as const) {
    const index = expenses.indexOf(marker);
    assert.ok(index > -1, `${label}: its query must still exist`);
  }

  // EVERY PAGED READ NEEDS A TOTAL ORDER. `expense_date` and `created_at` both repeat, and a
  // non-unique sort can drop one row and repeat another across a page boundary — a quieter version
  // of the bug being fixed. Each paged read adds `id` as the tiebreaker.
  assert.ok(
    (expenses.match(/\.order\("id", \{ ascending: true \}\)/g) ?? []).length >= 6,
    "each paged read must carry an `id` tiebreaker so its page boundaries are stable",
  );

  // The write path: the upsert is not capped, but what it RETURNS is — and that return feeds both
  // the screen and the payroll resync diff.
  assert.match(
    expenses,
    /for \(let start = 0; start < payload\.length; start \+= UPSERT_CHUNK_SIZE\)/,
    "savePayrollExpenseApprovals must upsert in chunks so the returned rows are never truncated",
  );
  assert.match(
    expenses,
    /written\.map\(\(row\) => toExpenseDecisionSnapshot\(row\)\)/,
    "and the payroll resync must diff against every written row, not one capped page of them",
  );

  // The helper must stay import-free so this test can exercise it without constructing a Supabase
  // admin client — the same reason claims-read-flag.ts is kept bare.
  const helper = readSource("../src/lib/outstation/page-all-rows.ts");
  assert.doesNotMatch(
    stripComments(helper),
    /^\s*import\s/m,
    "page-all-rows.ts must import nothing",
  );
}
