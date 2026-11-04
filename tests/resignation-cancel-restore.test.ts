import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { restoreEmployeeAfterCancelledResignation } from "../src/lib/resignations/service.ts";

// Cancelling a resignation used to stamp only the resignation row. One filed from the Employees
// page ends the person on the spot (resigned, off payroll, out of the seat, replacement vacancy
// open, login off, CRM id cleared), so "cancel" left all of that in force: Omaima Wael (AI-0009)
// was never leaving — she was moving from Anti Infective to Pedia — and cancelling would not have
// put her back. phx_restore_employee_after_cancelled_resignation undoes it in one transaction.

type RestoreClient = Parameters<typeof restoreEmployeeAfterCancelledResignation>[0];

function rpcClient(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  } as unknown as RestoreClient;
  return { calls, client };
}

function workflowBody(source: string): string {
  const start = source.indexOf("export async function runResignationWorkflow(");
  const end = source.indexOf("export async function restoreEmployeeAfterCancelledResignation(");
  assert.ok(start >= 0 && end > start, "runResignationWorkflow and the restore helper both exist, in that order");
  return source.slice(start, end);
}

export async function runResignationCancelRestoreTests() {
  const restored = rpcClient({ data: { restored: true, employeeHrId: "AI-0009", seatsRestored: ["SEAT-AIF-REP-GZ2"] } });
  assert.equal(
    await restoreEmployeeAfterCancelledResignation(restored.client, "507c18b9-9f9d-457d-950c-7ce8e9abeeaa", "B-10"),
    true,
  );
  assert.deepEqual(restored.calls, [
    {
      fn: "phx_restore_employee_after_cancelled_resignation",
      args: { p_actor: "B-10", p_resignation_id: "507c18b9-9f9d-457d-950c-7ce8e9abeeaa" },
    },
  ]);

  const nothing = rpcClient({ data: { restored: false, reason: "employee_not_terminal" } });
  assert.equal(
    await restoreEmployeeAfterCancelledResignation(nothing.client, "r-1", "B-10"),
    false,
    "a resignation that never ended anyone restores nothing and is not an error",
  );

  const refused = rpcClient({
    error: { message: "restore: the seat AI-0009 left has since been given to someone else: SEAT-AIF-REP-GZ2 (now B-200) — move them first" },
  });
  await assert.rejects(
    () => restoreEmployeeAfterCancelledResignation(refused.client, "r-1", "B-10"),
    (error: Error) => error.message.startsWith("the seat AI-0009 left has since been given to someone else"),
    "the SQL refusal reaches the screen as its own sentence, prefix dropped",
  );

  // Cancel and reject both restore, and BEFORE the row is stamped, so a refusal leaves the
  // resignation exactly as it was.
  const body = workflowBody(readFileSync("src/lib/resignations/service.ts", "utf8"));
  const restoreCall = body.indexOf("await restoreEmployeeAfterCancelledResignation(supabase, row.id, actorHrId)");
  const rowStamp = body.indexOf(".update(updates)");
  assert.ok(restoreCall > 0, "runResignationWorkflow calls the restore");
  assert.ok(rowStamp > restoreCall, "the restore runs before the resignation row is stamped cancelled");
  assert.match(
    body,
    /if \(action === "cancel" \|\| action === "reject"\) \{\s*restoredEmployee = await restoreEmployeeAfterCancelledResignation/,
    "both cancel and reject restore the employee",
  );
  assert.match(body, /if \(restoredEmployee\) \{\s*invalidateEmployeeDirectoryCache\(\);/, "a restore refreshes the employee directory");

  // The SQL refuses every case where giving the job back would take it from someone else.
  const sql = readFileSync("supabase/migrations/20261104174918_resignation_cancel_restores_and_line_move.sql", "utf8");
  for (const [guard, why] of [
    ["a completed resignation cannot be cancelled", "a completed exit is final"],
    ["has a newer exit record", "only the exit that took them out is undone"],
    ["they were taken out by something else", "the employee's last day must be this resignation's"],
    ["has since been given to someone else", "a seat re-filled since is never taken back"],
    ["the replacement vacancy for % was already filled", "a hired replacement is never displaced"],
    ["'employee_not_terminal'", "a never-terminated employee is left alone"],
    ["crm_id = coalesce(crm_id, v_res.crm_id_before)", "the CRM id the resignation cleared comes back"],
    ["request.phx_allow_terminal_employee_reactivation', 'on'", "the terminal-status guard is opened only inside the restore"],
    ["v_employee.crm_id\n", "the resignation stores the CRM id it clears"],
  ] as const) {
    assert.ok(sql.replace(/\r\n/g, "\n").includes(guard), `migration keeps: ${why} (${guard.trim()})`);
  }
  // A person already re-hired under a new HR ID (same national ID) is never given the old record
  // back too: that pays one person twice (Omaima Wael, AI-0009 re-hired as PD-0039).
  const guard = readFileSync("supabase/migrations/20261104184517_restore_refuses_a_rehired_person.sql", "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.ok(
    guard.includes("btrim(e.national_id) = btrim(v_emp.national_id)") &&
      guard.includes("would put the same person on payroll twice"),
    "the latest restore refuses when the same national ID is still employed under another HR ID",
  );
  assert.ok(
    guard.indexOf("would put the same person on payroll twice") < guard.indexOf("perform set_config('request.phx_allow_terminal_employee_reactivation', 'on', true)"),
    "the re-hire refusal runs before anything is reactivated",
  );
  assert.ok(
    guard.includes("revoke execute on function public.phx_restore_employee_after_cancelled_resignation(uuid, text) from public, anon, authenticated;"),
    "the re-created restore stays closed to browser roles",
  );

  assert.ok(
    !/area_name\s*=\s*v_area\.name/.test(sql),
    "phx_transfer_au_seat no longer writes the dropped employees.area_name (every move onto an area seat failed 42703)",
  );
  for (const fn of [
    "phx_restore_employee_after_cancelled_resignation(uuid, text)",
    "phx_move_employee_to_line(text, text, text, date, text)",
    "phx_transfer_au_seat(text, text, text, date, text, text)",
    "phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text)",
  ]) {
    assert.ok(sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`), `${fn} is revoked from browser roles`);
  }
}
