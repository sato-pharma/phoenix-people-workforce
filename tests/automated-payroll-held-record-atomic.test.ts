import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assertEveryPublishedRunRecorded } from "../src/lib/automated-payroll/held-settlements.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE HELD-SALARY RECORD CANNOT BE LOST SILENTLY (enterprise audit 2026-11-13, F-PAY-002 / REC-047).
 *
 * Who is still owed held salary is rebuilt from a run's `published` audit row. That row was written
 * best-effort AFTER the run had already been marked published, so one failed insert left a published
 * month with no held record and its held people dropped out of every later Held Salary Release, with
 * nothing on screen saying so.
 *
 * Now:
 *   1. publish marks the run published AND writes the record in ONE database function
 *      (phx_mark_automated_payroll_run_published, migration 20261113160132), conditioned on its claim;
 *      a failed insert rolls the phase back, so the run stays `ready` and the publish is retried;
 *   2. the function refuses a record with no `held` list;
 *   3. the readers throw — never answer "nobody is held" — on a missing table, or on a published run
 *      with no record.
 *
 * Proven live on staging 2026-11-13 (forced failure inside the function's transaction leaves the run
 * in `ready` with no audit row); this file pins the shape so a later edit cannot quietly undo it.
 */

const MIGRATION = "supabase/migrations/20261113160132_automated_payroll_publish_records_hold_atomically.sql";

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of ${signature}`);
  return source.slice(start, end);
}

export function runAutomatedPayrollHeldRecordAtomicTests() {
  // ---- 1. The database function: phase and record together, or neither ---------------------------
  const sql = readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
  const fn = sql.slice(sql.indexOf("create or replace function public.phx_mark_automated_payroll_run_published("));
  assert.ok(fn.length > 0, "the migration defines phx_mark_automated_payroll_run_published");
  assert.match(fn, /jsonb_typeof\(p_detail -> 'held'\) is distinct from 'array'/, "a record with no held list is refused");
  const updateAt = fn.indexOf("update public.automated_payroll_runs");
  const insertAt = fn.indexOf("insert into public.automated_payroll_audit");
  assert.ok(updateAt > 0 && insertAt > updateAt, "the phase write and the record insert are in the SAME function");
  assert.match(fn, /and phase = 'ready'\s*\n\s*and transition_token = p_transition_token/, "the phase write is conditioned on the publish claim");
  assert.match(fn, /if not found then\s*\n\s*raise exception 'automated_payroll_transition_claim_lost/, "a lost claim raises, so nothing is recorded against a run another action took");
  assert.match(fn, /'published', null, p_detail/, "the row it writes is the `published` row the readers rebuild from");
  assert.match(sql, /revoke execute on function public\.phx_mark_automated_payroll_run_published\([^)]*\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.phx_mark_automated_payroll_run_published\([^)]*\) to service_role;/);

  // ---- 2. Publish uses it, inside the claim, and nothing else writes the `published` row ----------
  const service = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  const publish = bodyOf(service, "export async function publishToPayslips(");
  const markAt = publish.indexOf("await markRunPublished(");
  assert.ok(markAt > 0, "HEADLINE: publish marks the run through markRunPublished");
  assert.ok(markAt > publish.indexOf("await recordHeldReleases("), "after the money writes it records");
  assert.ok(markAt < publish.indexOf("}).catch((publishError"), "and inside whileClaimed, so a failure releases the claim");
  assert.ok(
    !/writeAutomatedPayrollAudit\(\{[\s\S]{0,120}action:\s*"published"\s*,/.test(publish),
    "the held record is never written best-effort again — only published_follow_up is",
  );
  assert.ok(!/phase:\s*"published"/.test(publish), "and the phase is never set by a plain updateRun beside it");
  const markCall = publish.slice(markAt, publish.indexOf("{ transitionToken: transition }", markAt));
  for (const key of ["held", "heldExcluded", "heldFirstPartTotal", "heldSecondPartTotal", "part1Unpaid", "deferred", "bankCoverage"]) {
    assert.match(markCall, new RegExp(`(^|[\\s{,])${key}\\s*[:,]`), `the atomic record carries \`${key}\``);
  }

  const store = stripComments(readFileSync("src/lib/automated-payroll/draft-store.ts", "utf8"));
  const mark = bodyOf(store, "export async function markRunPublished(");
  assert.match(mark, /rpc\("phx_mark_automated_payroll_run_published"/);
  assert.match(mark, /TRANSITION_CLAIM_LOST/, "a lost claim keeps the marker publish's recovery text looks for");
  assert.match(mark, /was NOT marked published/, "any other failure says the run was not published");

  // ---- 3. The readers fail loudly ----------------------------------------------------------------
  const held = stripComments(readFileSync("src/lib/automated-payroll/held-settlements.ts", "utf8"));
  const newest = bodyOf(held, "async function newestPublishedDetailByRun(");
  assert.ok(!newest.includes("isMissingTableError"), "a missing audit table is an error, never 'nobody is held'");
  assert.match(newest, /if \(error\) throw error;/);
  assert.match(newest, /assertEveryPublishedRunRecorded\(await publishedRunPeriods\(\), byRun\)/, "every published run must have its record");

  const holds = stripComments(readFileSync("src/lib/automated-payroll/published-holds.ts", "utf8"));
  const perRun = bodyOf(holds, "export async function readPublishedHoldRecord(");
  assert.ok(!perRun.includes("isMissingTableError"), "the per-run reader treats a missing table as an error too");
  assert.match(perRun, /phase === "published"[\s\S]*throw new Error/, "and a published run with no record throws");

  // The rule itself, with real months: a missing record names the month and lists nobody.
  const runs = [
    { id: "run-sep", month: 9, year: 2026 },
    { id: "run-aug", month: 8, year: 2026 },
  ];
  assert.doesNotThrow(() => assertEveryPublishedRunRecorded(runs, new Set(["run-sep", "run-aug"])));
  assert.throws(
    () => assertEveryPublishedRunRecorded(runs, new Set(["run-aug"])),
    /payroll for September 2026 is published but its record of who was held is missing\. Nothing is listed/,
    "HEADLINE: a lost record is an error naming the month, never an empty list",
  );
  assert.doesNotThrow(() => assertEveryPublishedRunRecorded([], new Set()), "no published month, nothing missing");
}
