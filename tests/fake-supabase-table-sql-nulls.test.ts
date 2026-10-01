import assert from "node:assert/strict";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * THE FAKE DATABASE MUST TREAT AN EMPTY CELL THE WAY POSTGRES DOES.
 *
 * tests/fixtures/fake-supabase-table.ts stands in for Supabase wherever a test cannot touch a real
 * database, and a test against it is only as good as its filters are faithful. The one place they
 * drifted was NULL. Postgres answers "unknown" whenever either side of `<>`, `<`, `<=` or `>=` is
 * NULL, and an unknown drops the row.
 *
 * `neq` kept those rows until 2026-10-01, and that hid a real defect: a payroll run's leave-balance
 * read dropped every settlement written outside any run, while the test written to catch exactly
 * that passed. `lt` and `lte` kept them too, by reading NULL as the empty string, which sorts below
 * every bound. A full-suite audit on 2026-10-01 found no test whose answer depended on either, so
 * this file pins the rule on the fixture itself: the next drift fails here, not as a false pass in
 * someone else's test.
 */

type Row = Record<string, unknown>;

/** One row with a value, one with an explicit NULL, and one that never had the column at all. */
function world() {
  return fakeSupabaseClient({
    t: [
      { id: "set", day: "2026-06-10", run: "r1" },
      { id: "null", day: null, run: null },
      { id: "absent" },
    ],
  });
}

function idsOf(data: unknown): string[] {
  return ((data ?? []) as Row[]).map((row) => String(row.id)).sort();
}

export async function runFakeSupabaseTableSqlNullsTests() {
  // ---- HEADLINE: a NULL cell never satisfies a range filter ----------------------------------------
  {
    const { data } = await world().from("t").select("id").lt("day", "2026-07-01");
    assert.deepEqual(
      idsOf(data),
      ["set"],
      "lt keeps only the row it can compare: reading NULL as the empty string kept the NULL and the " +
        "missing cell, because an empty string sorts below every bound",
    );
  }
  {
    const { data } = await world().from("t").select("id").lte("day", "2026-06-10");
    assert.deepEqual(idsOf(data), ["set"], "lte drops a NULL row exactly as lt does");
  }
  {
    const { data } = await world().from("t").select("id").gte("day", "");
    assert.deepEqual(
      idsOf(data),
      ["set"],
      "gte drops a NULL row even against an empty bound, where reading NULL as \"\" made it pass",
    );
  }

  // ---- A present value still compares as text, exactly as before -----------------------------------
  {
    const { data } = await world().from("t").select("id").lt("day", "2026-06-10");
    assert.deepEqual(idsOf(data), [], "lt is strict");
  }
  {
    const { data } = await world().from("t").select("id").lte("day", "2026-06-09");
    assert.deepEqual(idsOf(data), [], "lte stops at its bound");
  }
  {
    const { data } = await world().from("t").select("id").gte("day", "2026-06-10");
    assert.deepEqual(idsOf(data), ["set"], "gte includes its bound");
  }

  // ---- neq and or, pinned with them -------------------------------------------------------------------
  {
    const { data } = await world().from("t").select("id").neq("run", "r2");
    assert.deepEqual(idsOf(data), ["set"], "neq is SQL <>: a NULL is never \"not equal\" to anything");
  }
  {
    const { data } = await world().from("t").select("id").or("run.is.null,run.neq.r1");
    assert.deepEqual(
      idsOf(data),
      ["absent", "null"],
      "is.null inside or() is how a caller keeps the NULL rows a neq alone would drop",
    );
  }

  // ---- Writes filter by the same rule ------------------------------------------------------------------
  // An update or a delete is aimed with the same predicates, so a NULL row it would have hit is a
  // write the real database would never make.
  {
    const client = world();
    await client.from("t").update({ flagged: true }).lt("day", "2026-07-01");
    assert.deepEqual(
      client.rows("t").filter((row) => row.flagged === true).map((row) => String(row.id)),
      ["set"],
      "an update aimed with lt touches only the row lt can compare",
    );
  }
  {
    const client = world();
    await client.from("t").delete().lte("day", "2026-12-31");
    assert.deepEqual(
      client.rows("t").map((row) => String(row.id)).sort(),
      ["absent", "null"],
      "a delete aimed with lte leaves the NULL rows in place",
    );
  }
}
