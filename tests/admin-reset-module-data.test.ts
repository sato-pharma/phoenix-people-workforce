import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  latestFunctionBodies,
  splitStatements,
  unqualifiedWrites,
} from "./function-bodies-need-a-where-clause.test.ts";
import {
  RESET_GROUPS,
  RESET_SWITCHED_OFF_REASON,
  ResetSwitchedOffError,
  executeReset,
  executeResetWith,
  type ResetRpcCall,
} from "../src/lib/admin/data-reset.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE ADMIN "RESET MODULE DATA" BUTTON HAD NEVER DELETED A ROW.
//
// `phx_admin_reset_module_data` was nineteen bare `delete from <table>;` statements. PostgREST
// connects as `authenticator`, which preloads **safeupdate**, so the very first one was refused
// and the whole function aborted — for every scope, every time, since the day it shipped. Pasted
// into a SQL editor it worked perfectly, which is why it looked healthy.
// `tests/function-bodies-need-a-where-clause.test.ts` allow-listed it rather than re-arming a
// destructive path on its own; the owner made that call on 2026-10-23 ("fix the admin Reset module
// data deletes"), the allowlist entry is gone, and this file pins everything the WHERE clauses on
// their own would NOT have fixed:
//
//   1. The batch is the unit, so a still-LOCKED monthly closing keeps its whole batch instead of
//      aborting the reset or tearing a batch in half. Every Source of Sales delete is scoped to
//      one batch id.
//   2. All 27 tables the function empties are declared in RESET_GROUPS, in the order the function
//      deletes them — which is FK order. Eight of them (six Source of Sales rollups,
//      marketing_roi_request_geo_facts and direct_order_marketing_offsets) were being wiped by
//      cascade, counted nowhere and named nowhere: the sales card said "3 tables will be wiped"
//      over a reset that emptied nine.
//   3. `direct_order_marketing_offsets` is deleted BEFORE `marketing_requests` — its FK is
//      ON DELETE NO ACTION and NOT NULL, so the request delete raises foreign_key_violation until
//      the offset row is gone.
//   4. `marketing_request_events` is append-only (a trigger raises restrict_violation on DELETE)
//      and must never be a delete target.
//   5. The caller LOOPS, because one call clears at most 25 batches of the 156 on production. The
//      loop merges counts across passes, stops on `done`, and stops at the cap honestly rather
//      than reporting a partial reset as complete.
//
// 1–4 are read out of the migration history, so they survive a later migration editing the
// function. 5 runs the real loop against a stub RPC, so it needs no database.
// ─────────────────────────────────────────────────────────────────────────────

const RESET_FUNCTION = "public.phx_admin_reset_module_data";
const MIGRATIONS_DIR = join(import.meta.dirname ?? ".", "..", "supabase", "migrations");

/** Every `delete from <table>` in one chunk of SQL, in source order. */
function deleteTargets(sql: string): string[] {
  const targets: string[] = [];
  const pattern = /delete\s+from\s+([a-z0-9_]+)/gi;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    targets.push(match[1].toLowerCase());
  }
  return targets;
}

/** The slice of the function body that one scope's `if p_module in (…)` branch owns. */
function scopeSection(body: string, module: "sales" | "weekly" | "marketing"): string {
  const starts = (["sales", "weekly", "marketing"] as const).map((name) => ({
    name,
    at: body.indexOf(`p_module in ('${name}', 'all')`),
  }));
  for (const start of starts) {
    assert.ok(start.at > 0, `${RESET_FUNCTION} must branch on p_module in ('${start.name}', 'all')`);
  }
  const here = starts.find((s) => s.name === module)!.at;
  const next = starts.filter((s) => s.at > here).map((s) => s.at).sort((a, b) => a - b)[0];
  return body.slice(here, next ?? body.length);
}

export async function runAdminResetModuleDataTests() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

  const fn = latestFunctionBodies(files).get(RESET_FUNCTION);
  assert.ok(fn, `${RESET_FUNCTION} should be read out of the migration history`);
  const body = fn.body;
  const allSql = files.map((f) => f.sql).join("\n");

  // ── 1 · safeupdate: not one bare delete left ────────────────────────────────
  assert.deepEqual(
    unqualifiedWrites(body),
    [],
    "every delete in the reset function must carry a WHERE — safeupdate is preloaded on PostgREST's " +
      "`authenticator` role, and one bare delete aborts the whole reset, which is how this function " +
      "spent its entire life doing nothing",
  );

  // ── 2 · the declared tables ARE the deleted tables, in the order deleted ────
  for (const group of RESET_GROUPS) {
    assert.deepEqual(
      deleteTargets(scopeSection(body, group.module)),
      group.tables,
      `${group.module}: RESET_GROUPS must list exactly the tables the function deletes, in the same ` +
        "order. That order is FK order — it is what keeps direct_order_marketing_offsets ahead of " +
        "marketing_requests (NO ACTION, NOT NULL) and every child ahead of its batch — and the list " +
        "is what the confirmation card counts before the owner types CONFIRM DELETE",
    );
  }

  assert.equal(
    RESET_GROUPS.flatMap((g) => g.tables).length,
    27,
    "27 tables are emptied by a full reset. It read 19 until 2026-10-23, and the eight missing ones " +
      "(295,418 rows in source_of_sales_fact_rollup alone) went by cascade — deleted, counted " +
      "nowhere, named nowhere",
  );

  // ── 3 · Source of Sales deletes one BATCH at a time, never a whole table ────
  const salesStatements = splitStatements(scopeSection(body, "sales")).filter((s) =>
    /delete\s+from/i.test(s),
  );
  assert.equal(salesStatements.length, 9, "nine Source of Sales deletes, one per table in the group");
  for (const statement of salesStatements) {
    const flat = statement.replace(/\s+/g, " ").trim();
    assert.match(
      flat,
      /where (batch_id|id) = v_batch\b/i,
      "every Source of Sales delete must be scoped to the single batch being cleared: a whole-table " +
        "delete trips trg_lock_guard_del the moment it reaches a locked closing (9 live locks over 52 " +
        "of the 156 batches on production), and deleting only the unlocked rows would leave a torn " +
        `batch behind its own summaries and rollups. Offending statement: ${flat.slice(0, 120)}`,
    );
  }

  assert.match(
    scopeSection(body, "sales"),
    /l\.unlocked_at is null/i,
    "the deletable-batch query must join monthly_closing_locks on `unlocked_at is null` — that join " +
      "is phx_reject_write_to_locked_closing's own, copied so the two cannot drift",
  );

  // ── 4 · the append-only audit trail is never a delete target ────────────────
  assert.ok(
    !deleteTargets(body).includes("marketing_request_events"),
    "marketing_request_events is append-only (phx_marketing_request_events_immutable raises " +
      "restrict_violation on DELETE) and deleting the requests ADDS one request_deleted event per " +
      "request. Clearing it would abort the reset and destroy the audit trail in one statement",
  );
  assert.ok(
    RESET_GROUPS.some((g) => g.kept.some((note) => note.includes("marketing_request_events"))),
    "the confirmation card must say the audit trail is kept — it is the one thing a reset leaves " +
      "behind, and a surprise is worse than a line of text",
  );
  assert.ok(
    RESET_GROUPS.some((g) => g.kept.some((note) => /locked/i.test(note))),
    "the Source of Sales card must say a locked closing's batch is kept whole, because the owner " +
      "reading '9 tables will be wiped' would otherwise expect an empty module and get 52 batches",
  );

  // ── 5 · the one-argument signature is DROPPED, not left beside the new one ──
  assert.match(
    allSql,
    /drop function if exists public\.phx_admin_reset_module_data\(text\)\s*;/i,
    "the one-argument signature must be dropped: the return shape changed from an array to an " +
      "object, and a defaulted second argument OVERLOADS rather than supersedes — PostgREST then " +
      "refuses the call as ambiguous and the button breaks a second way",
  );
  assert.match(
    allSql,
    /grant execute on function public\.phx_admin_reset_module_data\(text, integer\) to service_role/i,
    "the new signature must keep service_role's execute grant — the API route calls it with the " +
      "service-role client and nothing else may",
  );

  // ── 6 · the loop: counts merge across passes, and it stops on `done` ────────
  function stubRpc(responses: unknown[]) {
    const calls: Array<{ p_module: string; p_max_batches: number }> = [];
    const rpc: ResetRpcCall = async (args) => {
      calls.push(args);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) return { data: null, error: { message: next.message } };
      return { data: next, error: null };
    };
    return { calls, rpc };
  }

  const twoPasses = stubRpc([
    {
      tables: [
        { table: "weekly_sales_rows", deleted: 40_000 },
        { table: "weekly_sales_batches", deleted: 25 },
      ],
      kept: [{ table: "source_of_sales_import_batches", batches: 52, reason: "locked" }],
      remaining: 62,
      done: false,
    },
    {
      tables: [
        { table: "weekly_sales_rows", deleted: 17_768 },
        { table: "weekly_sales_batches", deleted: 62 },
      ],
      kept: [],
      remaining: 0,
      done: true,
    },
  ]);
  const merged = await executeResetWith(twoPasses.rpc, "weekly", "B-10");

  assert.equal(twoPasses.calls.length, 2, "the loop stops on the pass that reports done");
  assert.deepEqual(
    twoPasses.calls[0],
    { p_module: "weekly", p_max_batches: 25 },
    "each call names the scope and asks for 25 batches — the chunk size that keeps one call inside " +
      "the Data API's patience and well under service_role's 300 s statement timeout",
  );
  assert.deepEqual(
    merged.tables,
    [
      { table: "weekly_sales_rows", deleted: 57_768 },
      { table: "weekly_sales_batches", deleted: 87 },
    ],
    "per-table counts must be SUMMED across passes and keep first-seen order — reporting only the " +
      "last pass would tell the owner 17,768 rows were deleted where 57,768 were",
  );
  assert.equal(merged.totalDeleted, 57_855);
  assert.equal(merged.completed, true);
  assert.equal(merged.remaining, 0);
  assert.equal(merged.passes, 2);
  assert.deepEqual(
    merged.kept,
    [],
    "the LAST pass's kept list wins: a lock lifted mid-run must not be reported as still holding",
  );

  // ── 7 · hitting the cap is reported as unfinished, never as complete ────────
  const stuck = stubRpc([
    { tables: [{ table: "source_of_sales_import_rows", deleted: 1 }], kept: [], remaining: 7, done: false },
  ]);
  const partial = await executeResetWith(stuck.rpc, "sales", "B-10");

  assert.equal(stuck.calls.length, 60, "the loop is capped at 60 passes rather than spinning for ever");
  assert.equal(
    partial.completed,
    false,
    "a run that hit the cap must report completed:false — the counts are real but the module is not " +
      "empty, and the card tells the owner to run it again instead of implying it finished",
  );
  assert.equal(partial.remaining, 7, "the batches still waiting are carried back to the caller");
  assert.equal(partial.tables[0].deleted, 60, "every pass's counts are kept, cap or no cap");

  // ── 8 · an RPC error surfaces, it does not read as an empty reset ───────────
  const failing = stubRpc([new Error("permission denied for table source_of_sales_import_rows")]);
  await assert.rejects(
    () => executeResetWith(failing.rpc, "all", "B-10"),
    /^Error: Reset failed: permission denied for table source_of_sales_import_rows$/,
    "a failed RPC must throw: swallowing it would render the success card over a reset that deleted " +
      "nothing, which is the exact failure this whole change exists to end",
  );

  // ── 9 · THE RESET IS SWITCHED OFF (owner, 23 Oct 2026) ──────────────────────
  // #6356 made it really delete, on production, guarded only by a closing LOCK (not a
  // publication), with nothing guarding Weekly Sales or Marketing Requests, no backup first and no
  // audit row. He chose "switch it off until safe". Every layer refuses, and the domain refuses
  // BEFORE any database client exists, so not even a local dev server (which points at the
  // production database) can reach the function.
  assert.ok(
    RESET_SWITCHED_OFF_REASON,
    "the reset stays switched off until a PR builds the published-month guard, a backup before " +
      "deleting and an audit row — turning it back on is that PR's job, never a drive-by",
  );
  await assert.rejects(
    () => executeReset("sales", "B-10"),
    (error: unknown) => error instanceof ResetSwitchedOffError,
    "executeReset must refuse before it creates a database client",
  );
  const root = join(import.meta.dirname ?? ".", "..");
  const route = readFileSync(join(root, "app", "api", "admin", "data-backup", "reset", "route.ts"), "utf8");
  const refusal = route.indexOf("if (RESET_SWITCHED_OFF_REASON)");
  assert.ok(refusal > 0, "the reset route must answer the switched-off reason itself");
  assert.ok(
    refusal < route.indexOf("await request.json()") && refusal < route.indexOf("executeReset("),
    "and it must do so before it reads the body or calls executeReset",
  );
  const card = readFileSync(join(root, "src", "components", "admin", "data-backup-reset-section.tsx"), "utf8");
  assert.equal(
    card.split('disabled={switchedOff || state.status === "loading"}').length - 1,
    2,
    "both buttons that open a reset confirmation are disabled while it is switched off",
  );
}
