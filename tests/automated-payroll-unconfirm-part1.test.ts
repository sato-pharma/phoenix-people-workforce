import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guards unconfirmPart1 (owner request 2026-07-26): after manually correcting
 * an employee's base salary post-confirm (Ahmed Nagy case), HR needs to reopen
 * a Part-1-confirmed run so the First Part recomputes from the corrected data
 * on the next confirm. unconfirmPart1 is not pure (Supabase reads/writes), so
 * this is a source-scan test — pinning the phase guard, the "clear every
 * frozen First Part" behavior, and the run-state reset, so a future refactor
 * can't silently leave a stale frozen value in place or unconfirm a run that
 * was never confirmed.
 */
export function runAutomatedPayrollUnconfirmPart1Tests() {
  const source = readFileSync(new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url), "utf8");

  const fnStart = source.indexOf("export async function unconfirmPart1");
  assert.ok(fnStart >= 0, "unconfirmPart1 must be exported from run-service.ts");
  const nextExportStart = source.indexOf("\nexport ", fnStart + 1);
  const fnBody = source.slice(fnStart, nextExportStart > 0 ? nextExportStart : undefined);

  assert.ok(
    fnBody.includes('if (run.phase !== "part2")'),
    "must only allow unconfirming a run whose Part 1 is confirmed and Part 2 is not (phase === 'part2')",
  );
  // ALL OR NOTHING (payroll audit 2026-11-14, finding 3; owner: "All or nothing"). The freeze, the
  // held-salary reservations and the phase are written by ONE database function in one transaction, so a
  // failure can no longer leave a Part 2 run with no frozen first instalment.
  assert.ok(
    fnBody.includes("await reopenPart1Atomically(runId, { actorHrId: actorId(access) }, { transitionToken: transition })"),
    "HEADLINE: Reopen Part 1 writes through the one all-or-nothing database call, under its claim",
  );
  for (const piecemeal of ["upsertDraftRows(", "recordHeldReleases(", "updateRun("]) {
    assert.ok(
      !fnBody.includes(piecemeal),
      `HEADLINE: Reopen Part 1 must not write piecemeal again (${piecemeal}) — a failure between two calls left Part 2 with no frozen first instalment`,
    );
  }
  const sql = readFileSync(
    new URL("../supabase/migrations/20261114170804_automated_payroll_reopen_part1_atomically.sql", import.meta.url),
    "utf8",
  );
  const fn = sql.slice(sql.indexOf("create or replace function public.phx_reopen_automated_payroll_part1("), sql.indexOf("$$;"));
  assert.ok(
    fn.includes("first_part_frozen = null"),
    "must clear every draft row's frozen First Part — a stale pre-correction value must not survive to Part 2",
  );
  assert.ok(fn.includes("phase = 'part1'"), "must reset the run back to the part1 phase");
  assert.ok(
    fn.includes("part1_confirmed_at = null") && fn.includes("part1_confirmed_by = null"),
    "must clear the Part 1 confirmation stamp so confirmPart1 can run again cleanly",
  );
  assert.match(
    fn,
    /where id = p_run_id\s+and phase = 'part2'\s+and transition_token = p_transition_token/,
    "the phase write is conditioned on the reopen's own claim and on Part 2",
  );
  assert.ok(
    fn.indexOf("if not found then") < fn.indexOf("update public.automated_payroll_draft_rows"),
    "a lost claim refuses before a single figure is touched",
  );
  assert.match(fn, /delete from public\.automated_payroll_held_releases\s+where paying_run_id = p_run_id;/, "the held-salary reservations go in the same transaction");
  assert.match(fn, /'stage', 'part1_reopened'/, "and their withdrawal is on the record");
  assert.match(fn, /security invoker/, "the function runs with the caller's rights, not the owner's");
  assert.match(
    sql,
    /revoke execute on function public\.phx_reopen_automated_payroll_part1\(uuid, uuid, text\) from public, anon, authenticated;/,
    "nobody outside the server can reopen Part 1",
  );
  assert.match(sql, /grant execute on function public\.phx_reopen_automated_payroll_part1\(uuid, uuid, text\) to service_role;/);
  const store = readFileSync(new URL("../src/lib/automated-payroll/draft-store.ts", import.meta.url), "utf8");
  assert.match(
    store,
    /rpc\("phx_reopen_automated_payroll_part1", \{\s*p_run_id: id,\s*p_transition_token: options\.transitionToken,\s*p_actor_hr_id: input\.actorHrId,/,
    "the store calls the function with the reopen's own claim",
  );
  assert.ok(fnBody.includes('action: "part1_unconfirmed"'), "must write an audit log entry for the reversal");

  // ---- API route + UI wiring --------------------------------------------
  const routeSource = readFileSync(
    new URL("../app/api/automated-payroll/runs/[runId]/part1/unconfirm/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(routeSource.includes("unconfirmPart1"), "the unconfirm API route must call the service function");
  assert.ok(routeSource.includes("assertSameOriginMutation"), "the mutation route must carry the CSRF guard like every other automated-payroll route");

  const wizardSource = readFileSync(
    new URL("../src/components/automated-payroll/automated-payroll-wizard.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    wizardSource.includes("/part1/unconfirm"),
    "the wizard must expose an Unconfirm Part 1 action wired to the new route",
  );
}
