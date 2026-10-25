import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The departed-agent CRM id reconcile reads `crm_agent_crm_ids_calc()` ONCE per run.
 *
 * It was the second-heaviest statement on the production database on 25 Oct 2026, when the 2 GB box
 * had restarted 11 times in 14 days, every time in working hours: 30 runs, 3.9 s mean, 9.7 s max,
 * 164,327 blocks read. EXPLAIN of the old body showed two "Function Scan on crm_agent_crm_ids_calc"
 * nodes — one per EXCEPT arm, because a function with a SET clause is never inlined — and a run that
 * found a difference then called `_rebuild()`, which read it a third time. Each read is the
 * ~136,000-row DISTINCT over the union visits door.
 *
 * 20261025030000 holds the answer in one local array and diffs and refills from it. This file pins
 * the four ways that can quietly come back: a second `_calc()` read, a call to `_rebuild()` (a third
 * read hidden behind a name), an unqualified DELETE (`safeupdate` refuses it through PostgREST —
 * 20261023154500), and a caught exception (the `_run()` wrapper records success only when nothing
 * failed, so a swallowed error would report "in step" on a run that never ran).
 */

const MIGRATION = "supabase/migrations/20261025030000_crm_agent_crm_ids_reconcile_single_pass.sql";

function sqlSource(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function reconcileBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.crm_agent_crm_ids_reconcile(");
  assert.notEqual(start, -1, `crm_agent_crm_ids_reconcile() is defined in ${MIGRATION}`);
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, "the reconcile's body ends");
  return flat(sql.slice(start, end));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export async function runCrmAgentCrmIdsReconcileSinglePassTests(): Promise<void> {
  const sql = sqlSource();
  const body = reconcileBody(sql);

  assert.equal(
    count(body, "public.crm_agent_crm_ids_calc()"),
    1,
    "the reconcile reads _calc() exactly once per run",
  );
  assert.ok(!body.includes("crm_agent_crm_ids_rebuild"), "the reconcile refills from its own array, never through _rebuild()");
  assert.equal(count(body, "unnest(v_truth)"), 3, "both EXCEPT arms and the refill read the one array");
  assert.ok(
    body.includes("delete from public.crm_agent_crm_ids_cache where true;"),
    "the refill's DELETE carries `where true`, which safeupdate requires through PostgREST",
  );
  assert.ok(!/\bexception\b/.test(body), "nothing is caught: a failed run must fail the wrapper");
  assert.ok(body.includes("raise warning"), "a difference is still raised as a warning");
  assert.ok(body.includes("returns integer"), "the signature the _run() wrapper calls is unchanged");
  assert.ok(body.includes("security definer set search_path to 'public'"), "security definer with a pinned search_path");

  const all = flat(sql);
  assert.ok(
    all.includes("revoke execute on function public.crm_agent_crm_ids_reconcile() from public, anon, authenticated;"),
    "the reconcile is revoked from every client role",
  );
  assert.ok(
    all.includes("grant execute on function public.crm_agent_crm_ids_reconcile() to service_role;"),
    "the reconcile stays service-role only",
  );
  assert.ok(!all.includes("cron.schedule"), "the reconcile's cron job and its heartbeat are untouched");
  assert.ok(!all.includes("crm_visits_unified"), "_calc() stays the one body that reads the visits door");
}
