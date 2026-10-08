import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import { findOrphanedRequests } from "../src/lib/approvals/orphaned-requests.ts";

/**
 * THE READER of the orphaned-request detector — `findOrphanedRequests` itself, fed by a fake Supabase
 * client that answers the way Postgres does. `tests/orphaned-requests.test.ts` covers the PURE layer
 * (`selectOrphanedRequests`, `summarizeOrphans`); every gap below lived in the reader, where that test
 * could not see it, and until 2026-10-08 the reader had no test at all.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. A RETURNED VACATION is the EMPLOYEE's to answer. While `BACK_WITH_REQUESTER.vacation` was empty,
 *     a resigned employee's returned vacation went down the approver branch, found no pending rung
 *     and was dropped without a trace.
 *  2. A REVERSED or EXPIRED direct order is FINISHED, and a DRAFT waits on nobody but its author. Steps
 *     are not cleaned up when an order ends (59 still-`pending` steps sat on rejected orders on
 *     2026-10-08), so a terminal status missing from `NO_ACTOR_EXPECTED` reads as "awaiting its
 *     approver" and a resigned name on a leftover rung is reported as stuck.
 *  3. CASING CANNOT HIDE AN ACTOR. The fake's `.in()` and `.eq()` are case-SENSITIVE, exactly like
 *     Postgres, so a reader that filters the employee master with `.in("hr_id", rawIds)` misses an
 *     actor stored as `c-o9` but named `C-O9` on the request — and a missing master row is read as
 *     "unknown, leave alone", so the orphan vanishes.
 *  4. The controls: an ACTIVE requester's returned vacation is not flagged, a returned request is
 *     never resolved through a leftover approval step, and a failed read THROWS rather than reporting
 *     a calm, empty board.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** A thenable query that applies the filters the reader uses, case-sensitively, as Postgres does. */
class FakeQuery implements PromiseLike<{ data: Row[] | null; error: Error | null }> {
  private readonly filters: Filter[] = [];
  private window: [number, number] | null = null;
  private orderColumn: string | null = null;
  private readonly rows: readonly Row[];
  private readonly failure: Error | null;

  constructor(rows: readonly Row[], failure: Error | null) {
    this.rows = rows;
    this.failure = failure;
  }

  select(_columns: string) {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  not(column: string, operator: string, value: string) {
    assert.equal(operator, "in", "the reader only ever uses not-in");
    const list = value.replace(/^\(|\)$/g, "").split(",");
    this.filters.push((row) => !list.includes(String(row[column])));
    return this;
  }

  order(column: string) {
    this.orderColumn = column;
    return this;
  }

  range(from: number, to: number) {
    this.window = [from, to];
    return this;
  }

  then<TResult1 = { data: Row[] | null; error: Error | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: Error | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let result: { data: Row[] | null; error: Error | null };
    if (this.failure) {
      result = { data: null, error: this.failure };
    } else {
      let data = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
      const column = this.orderColumn;
      if (column) data = [...data].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
      if (this.window) data = data.slice(this.window[0], this.window[1] + 1);
      result = { data, error: null };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

function fakeClient(tables: Record<string, readonly Row[]>, failing: Record<string, Error> = {}): SupabaseClient {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? [], failing[table] ?? null);
    },
  } as unknown as SupabaseClient;
}

const AT = "2026-09-01T00:00:00.000Z";

function baseTables(): Record<string, Row[]> {
  return {
    employees: [
      // Stored lower-case, as one live HR_ID really is — the request rows name it upper-case.
      { hr_id: "c-o9", full_name: "Resigned Approver", employment_status: "resigned" },
      { hr_id: "B-23", full_name: "Resigned Employee", employment_status: "resigned" },
      { hr_id: "B-99", full_name: "Active Employee", employment_status: "active" },
      { hr_id: "PD-0010", full_name: "Resigned Manager", employment_status: "resigned" },
    ],
    marketing_requests: [],
    marketing_request_approval_steps: [],
    direct_order_requests: [
      // Gap 2 — finished or unsubmitted, each with a LEFTOVER pending rung naming a resigned person.
      { id: "do-reversed", status: "reversed", requester_hr_id: "B-99", updated_at: AT },
      { id: "do-expired", status: "expired", requester_hr_id: "B-99", updated_at: AT },
      { id: "do-draft", status: "draft", requester_hr_id: "B-99", updated_at: AT },
      // Gap 3 — a live order whose pending rung names the lower-case-stored approver in upper case.
      { id: "do-live", status: "pending_approval", requester_hr_id: "B-99", updated_at: AT },
    ],
    direct_order_approval_steps: [
      { request_id: "do-reversed", step_order: 1, approver_hr_id: "PD-0010", status: "pending" },
      { request_id: "do-expired", step_order: 1, approver_hr_id: "PD-0010", status: "pending" },
      { request_id: "do-draft", step_order: 1, approver_hr_id: "PD-0010", status: "pending" },
      { request_id: "do-live", step_order: 1, approver_hr_id: "C-O9", status: "pending" },
    ],
    v2_vacation_requests: [
      // Gap 1 — returned to an employee who has since resigned.
      { id: "vac-returned-resigned", status: "returned", employee_hr_id: "B-23", updated_at: "2026-08-15T00:00:00.000Z" },
      // Control — returned to an employee who is still here: pending HIM, not stranded.
      { id: "vac-returned-active", status: "returned", employee_hr_id: "B-99", updated_at: AT },
    ],
    v2_vacation_approval_steps: [
      // A leftover rung on the returned vacation of the ACTIVE employee, naming a resigned manager.
      // A returned request is the requester's; it must never be judged through this rung.
      { request_id: "vac-returned-active", step_order: 1, approver_hr_id: "PD-0010", status: "pending" },
    ],
  };
}

export async function runOrphanedRequestsReaderTests() {
  const orphans = await findOrphanedRequests(fakeClient(baseTables()));
  const byKey = new Map(orphans.map((orphan) => [orphan.requestKey, orphan]));

  // ── 1. A returned vacation is the employee's ─────────────────────────────────────────────────
  const vacation = byKey.get("vac-returned-resigned");
  assert.ok(
    vacation,
    "A RETURNED VACATION OF A RESIGNED EMPLOYEE MUST BE FLAGGED. It waits on the employee to resubmit, and they cannot log in — but with `returned` missing from BACK_WITH_REQUESTER.vacation the reader looks for a pending approver rung, finds none, and drops it without a trace.",
  );
  assert.equal(vacation?.actorRole, "requester", "the person who cannot act on a returned vacation is the EMPLOYEE who asked for it");
  assert.equal(vacation?.actorName, "Resigned Employee", "the orphan carries the employee's NAME, never an id");
  assert.equal(vacation?.module, "vacation");

  assert.ok(
    !byKey.has("vac-returned-active"),
    "a returned vacation whose employee is still ACTIVE is simply waiting on them — and the leftover rung naming a resigned manager must never be read for a returned request",
  );

  // ── 2. Finished and unsubmitted direct orders await nobody ───────────────────────────────────
  for (const key of ["do-reversed", "do-expired"]) {
    assert.ok(
      !byKey.has(key),
      `${key}: A REVERSED OR EXPIRED DIRECT ORDER IS FINISHED. Its leftover pending rung names a resigned person, and a terminal status missing from NO_ACTOR_EXPECTED["direct-order"] reads as "awaiting its approver" — a false stuck item on the owner's board.`,
    );
  }
  assert.ok(
    !byKey.has("do-draft"),
    "A DRAFT DIRECT ORDER IS NOT SUBMITTED — it sits with its author, in nobody's queue, and must never be reported as stuck on an approver.",
  );

  // ── 3. Casing cannot hide an actor ───────────────────────────────────────────────────────────
  const live = byKey.get("do-live");
  assert.ok(
    live,
    'CASING HID A RESIGNED APPROVER. The rung names "C-O9" and the master stores "c-o9"; Postgres equality is case-sensitive, so filtering the master with .in("hr_id", rawIds) returns no row, and a missing row is read as "unknown, leave alone". The master must be read whole and keyed through hrKey.',
  );
  assert.equal(live?.actorRole, "approver");
  assert.equal(live?.actorName, "Resigned Approver");

  assert.deepEqual(
    orphans.map((orphan) => orphan.requestKey).sort(),
    ["do-live", "vac-returned-resigned"],
    "exactly the two stranded requests, nothing more",
  );

  // ── 3b. The master is read in pages, so a long master cannot truncate to a silent miss ────────
  const longMaster = baseTables();
  const filler = Array.from({ length: 1000 }, (_, index) => ({
    hr_id: `A-${String(index).padStart(4, "0")}`,
    full_name: `Filler ${index}`,
    employment_status: "active",
  }));
  longMaster.employees = [...filler, ...longMaster.employees];
  const paged = await findOrphanedRequests(fakeClient(longMaster));
  assert.deepEqual(
    paged.map((orphan) => orphan.requestKey).sort(),
    ["do-live", "vac-returned-resigned"],
    "with more than 1,000 employees the actors sit on the SECOND page — a reader that stops after one page misses them",
  );

  // ── 4. A failed read throws, never a calm empty board ────────────────────────────────────────
  for (const table of ["direct_order_requests", "v2_vacation_requests", "employees"]) {
    await assert.rejects(
      () => findOrphanedRequests(fakeClient(baseTables(), { [table]: new Error(`${table} unreadable`) })),
      new RegExp(`${table} unreadable`),
      `an unread ${table} must surface as "could not be read", never as "nothing is stuck"`,
    );
  }
}
