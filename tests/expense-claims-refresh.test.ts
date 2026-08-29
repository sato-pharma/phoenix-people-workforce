import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { refreshExpenseClaims, type SupabaseAdmin } from "../src/lib/outstation/claims-refresh.ts";

// The `expense_claims` mirror is what approvers actually read in production
// (`PHOENIX_EXPENSE_CLAIMS_READ=true`), while writes still land in the legacy outstation tables.
// It is only correct for as long as something rebuilds it, and for ten days nothing did — the
// rebuild function had no caller at all. These tests pin the two things that make the new
// scheduled caller trustworthy: that it never reports a refusal as success, and that its parity
// read-back cannot silently under-report drift.

type QueryResult = { data: unknown; count: number | null; error: unknown };

type FakeBuilder = {
  neq: (column: string, value: string) => FakeBuilder;
  limit: (count: number) => FakeBuilder;
  then: (resolve: (value: QueryResult) => unknown) => Promise<unknown>;
};

type FakeOptions = {
  rpcResult?: { data: unknown; error: unknown };
  total?: number;
  driftedRefs?: string[];
  parityError?: unknown;
};

/** Minimal stub of the Supabase surface `refreshExpenseClaims` uses (rpc + a parity select). */
function fakeSupabase(options: FakeOptions) {
  const calls = { rpc: [] as string[], usedHeadCount: false, boundedDriftRead: false };

  const settle = (result: QueryResult): FakeBuilder => {
    const builder: FakeBuilder = {
      neq: () => builder,
      limit: () => {
        calls.boundedDriftRead = true;
        return builder;
      },
      then: (resolve) => Promise.resolve(result).then(resolve),
    };
    return builder;
  };

  const supabase = {
    rpc: async (name: string) => {
      calls.rpc.push(name);
      return options.rpcResult ?? { data: {}, error: null };
    },
    from: () => ({
      select: (_columns: string, selectOptions?: { count?: string; head?: boolean }) => {
        const error = options.parityError ?? null;
        if (selectOptions?.head) {
          calls.usedHeadCount = true;
          return settle({ data: null, count: options.total ?? 0, error });
        }
        const drifted = options.driftedRefs ?? [];
        return settle({
          data: drifted.map((claimRef) => ({ claim_ref: claimRef })),
          count: drifted.length,
          error,
        });
      },
    }),
  } as unknown as SupabaseAdmin;

  return { supabase, calls };
}

const rebuilt = {
  data: { claims: 406, imports: 2, flagged: 8, refreshed_at: "2026-08-29T17:53:47.235318+00:00" },
  error: null,
};

export async function runExpenseClaimsRefreshTests() {
  // A clean rebuild reports the counts the function returned, and parity confirms it.
  {
    const { supabase, calls } = fakeSupabase({ rpcResult: rebuilt, total: 406, driftedRefs: [] });
    const result = await refreshExpenseClaims(supabase);
    assert(result.status === "refreshed", "a successful rpc must report refreshed");
    assert.equal(result.claims, 406);
    assert.equal(result.imports, 2);
    assert.equal(result.flagged, 8);
    assert.equal(result.refreshedAt, "2026-08-29T17:53:47.235318+00:00");
    assert.equal(result.parity?.clean, true, "no drifted rows means parity is clean");
    assert.equal(result.parity?.total, 406);
    assert.deepEqual(calls.rpc, ["phx_refresh_expense_claims"], "exactly one rebuild per run");
  }

  // Drift AFTER a rebuild still reports `refreshed` — the rebuild did happen. The verdict rides on
  // `parity`, which is what the route turns into a 500. Collapsing the two would make a mirror that
  // disagrees with legacy indistinguishable from a healthy run.
  {
    const { supabase } = fakeSupabase({
      rpcResult: rebuilt,
      total: 406,
      driftedRefs: ["OUTSTATION-92", "OUTSTATION-77"],
    });
    const result = await refreshExpenseClaims(supabase);
    assert(result.status === "refreshed", "a rebuild that ran is still a rebuild that ran");
    assert.equal(result.parity?.clean, false, "drifted rows must not read as clean");
    assert.equal(result.parity?.drifted, 2);
    assert.deepEqual(
      result.parity?.driftedRefs,
      ["OUTSTATION-92", "OUTSTATION-77"],
      "the refs travel with the verdict so a failure names itself in the job history",
    );
  }

  // The parity read must never be an unbounded select: PostgREST stops at 1000 rows with no marker,
  // which would silently under-report drift — the exact failure this job exists to catch.
  {
    const { supabase, calls } = fakeSupabase({ rpcResult: rebuilt, total: 406, driftedRefs: [] });
    await refreshExpenseClaims(supabase);
    assert(calls.usedHeadCount, "the row total must come from an exact count, not from counting rows");
    assert(calls.boundedDriftRead, "the drifted-row read must be bounded by an explicit limit");
  }

  // An interlock refusal (P0001) is a decision, not a fault, and above all not a success.
  {
    const reason =
      "Refusing to rebuild: 3 expense_payroll_links row(s) exist. This function DELETES that table and never rebuilds it.";
    const { supabase } = fakeSupabase({
      rpcResult: { data: null, error: { code: "P0001", message: reason } },
    });
    const result = await refreshExpenseClaims(supabase);
    assert(result.status === "blocked", "a refused rebuild must never report as refreshed");
    assert.equal(result.reason, reason, "the interlock's own message says which guard fired and why");
  }

  // Any other database error is a real fault and must propagate. Swallowing it as `blocked` would
  // dress a broken job up as a deliberate refusal and stop anyone looking.
  {
    const { supabase } = fakeSupabase({
      rpcResult: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    });
    // Matched by shape, not by regex: a Supabase error is a plain object, not an Error instance,
    // and this module rethrows it untouched exactly as `expenses.ts` does. Asserting on the object
    // is what pins that the original code and message survive the trip.
    await assert.rejects(
      () => refreshExpenseClaims(supabase),
      (error: unknown) => {
        const raw = error as { code?: string; message?: string };
        assert.equal(raw.code, "57014", "the original error propagates unchanged, code and all");
        assert.match(String(raw.message), /statement timeout/);
        return true;
      },
      "a non-P0001 error must throw, not be reported as an interlock refusal",
    );
  }

  // The rebuild has already committed by the time parity is read. A failing read-back is worth
  // reporting as unknown, but must not turn a successful rebuild into a failed job.
  {
    const { supabase } = fakeSupabase({
      rpcResult: rebuilt,
      parityError: { code: "42501", message: "permission denied for view v_expense_claims_parity" },
    });
    const result = await refreshExpenseClaims(supabase);
    assert(result.status === "refreshed", "a parity read failure must not undo a committed rebuild");
    assert.equal(result.parity, null, "unknown parity is null, never a fabricated clean verdict");
    assert.equal(result.claims, 406);
  }

  // The guard has to live in the DATABASE, ahead of the delete it protects against — a caller-side
  // check would be bypassed by the next hand-run. Pin the newest migration that re-issues the
  // function, so re-issuing it without the guard turns the PR red.
  {
    const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
    const bodies = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(new URL(name, migrationsDir), "utf8") }))
      .filter((file) => file.sql.includes("function public.phx_refresh_expense_claims"));

    assert(bodies.length > 0, "at least one migration must define phx_refresh_expense_claims");

    const newest = bodies[bodies.length - 1];
    const guardAt = newest.sql.indexOf("expense_payroll_links row(s) exist");
    const deleteAt = newest.sql.indexOf("delete from public.expense_payroll_links");

    assert(
      guardAt !== -1,
      `${newest.name} re-issues phx_refresh_expense_claims without the payroll-links interlock`,
    );
    assert(deleteAt !== -1, `${newest.name} should still clear expense_payroll_links during a rebuild`);
    assert(
      guardAt < deleteAt,
      "the interlock must be raised BEFORE the delete — after it, the linkage is already gone",
    );
  }

  // A DELETE with no WHERE clause is unrunnable through PostgREST — and ONLY through PostgREST.
  //
  // PostgREST connects as `authenticator`, which on this project preloads the `safeupdate` library
  // (measured: session_preload_libraries = "supautils, safeupdate"). It refuses any unqualified
  // DELETE or UPDATE. A direct SQL session does NOT preload it, so a bare delete here works in
  // psql, in the Supabase SQL editor and over MCP — every way a human has ever run this function —
  // while failing on every single scheduled call with `DELETE requires a WHERE clause`.
  //
  // That is not hypothetical: it is what the first production request after the cron route shipped
  // did, at 2026-08-29 18:25:35.711 UTC. The route reported an opaque 500 and the mirror silently
  // went un-rebuilt. SECURITY DEFINER does not rescue it — the library is preloaded per SESSION,
  // not per function owner.
  //
  // `authenticator` also carries statement_timeout = 8s, and that cap applies on the HTTP path
  // alone, so the function must set its own or it will keep working by hand while failing hourly
  // the moment the rebuild outgrows eight seconds.
  {
    const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
    const newest = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(new URL(name, migrationsDir), "utf8") }))
      .filter((file) => file.sql.includes("function public.phx_refresh_expense_claims"))
      .pop();

    assert(newest, "at least one migration must define phx_refresh_expense_claims");

    const bareDeletes = newest.sql
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^delete\s+from\s+[\w.]+\s*;$/i.test(line));

    assert.deepEqual(
      bareDeletes,
      [],
      `${newest.name} issues DELETE(s) with no WHERE clause, which PostgREST's authenticator role refuses outright: ${bareDeletes.join(" | ")}`,
    );

    // Scan real DDL lines, not the whole file. This migration EXPLAINS the clause in its header
    // comment, so a plain substring search over the source also passes on a migration that merely
    // mentions statement_timeout without actually setting it — measured: deleting the real clause
    // left that weaker check green.
    const setsTimeout = newest.sql
      .split("\n")
      .some((line) => !line.trim().startsWith("--") && /^\s*set\s+statement_timeout\s+to\b/i.test(line));

    assert(
      setsTimeout,
      `${newest.name} must set its own statement_timeout — authenticator caps statements at 8s, and only on the HTTP path`,
    );
  }
}
