import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A LEAVER WHOSE RESIGNATION IS STILL IN THE WORKFLOW IS NEVER PAID A FULL MONTH.
 *
 * Cycle 1 finding 36. The Ready payroll sheet splits the company into two populations:
 *
 *   - `activeEmployees`  — employment_status 'active' and payroll-eligible. These get
 *     `lastWorkingDate: null` and `isTerminalPayroll: false`, which is a FULL UNPRORATED MONTH.
 *   - `terminalEmployees` — employment_status in terminalPayrollStatuses with a terminal date
 *     inside the run's month. These prorate to the days actually worked.
 *
 * The finding said a leaver whose resignation was still in the workflow landed in the first
 * population and was paid a whole month. PR #3717 claimed it had been "already closed by earlier
 * work" and named no such work; neither the number nor a marker appeared anywhere in the tree, so
 * the ledger recorded it as claimed-closed-with-no-evidence and it stayed that way.
 *
 * It IS closed, and this file pins the mechanism that closes it, because that mechanism is not
 * obvious and nothing else guards it:
 *
 *   **employment_status is written when the resignation is FILED, not when its workflow
 *   completes.** `phx_resign_employee_and_open_vacancy` sets it in the same statement that files
 *   the exit. So an employee sitting at workflow status 'submitted' — still in the workflow by any
 *   reading — is ALREADY 'resigned' on the employees row, and the Ready sheet's terminal branch
 *   picks them up. Verified on production 2026-09-12: the one resignation still at 'submitted'
 *   carried employment_status 'resigned', and no row anywhere had an in-flight resignation against
 *   an employee still 'active'.
 *
 * That makes the closure a consequence of WHERE the status write lives. Move it to the workflow's
 * completion step — an entirely reasonable-looking tidy-up, since the rest of the resignation
 * lifecycle is workflow-driven — and every leaver silently returns to a full unprorated month with
 * nothing going red. That is the regression this file exists to catch.
 *
 * WHAT THIS FILE CANNOT SEE. These are source and migration assertions, not a live database. They
 * prove the shipped SQL still writes the status at filing and that the Ready sheet still reads all
 * three terminal statuses. They cannot prove the deployed function matches the migrations — query
 * pg_get_functiondef on production for that.
 */

const READY_SHEET = "app/api/payroll/template/route.ts";
const MIGRATIONS_DIR = "supabase/migrations";
const RESIGN_RPC = "public.phx_resign_employee_and_open_vacancy";
const STATUS_WRITE = "employment_status = p_employee_status";

/** The body of one `create or replace function` statement, bounded at its own terminator. */
function functionBodies(sql: string, signature: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = sql.indexOf(signature, from);
    if (start < 0) break;
    const end = sql.indexOf("$$;", start);
    bodies.push(end < 0 ? sql.slice(start) : sql.slice(start, end));
    from = end < 0 ? sql.length : end + 3;
  }
  return bodies;
}

export async function runPayrollReadySheetLeaverProrationTests() {
  // ---- 1. The Ready sheet's two populations, and what separates them ----------------------------
  const route = readFileSync(READY_SHEET, "utf8");

  assert.ok(
    route.includes('const terminalPayrollStatuses = new Set(["resigned", "terminated", "inactive"]);'),
    "HEADLINE: the Ready sheet must treat resigned, terminated AND inactive as terminal — dropping " +
      "any one of them moves that leaver into the full-month branch, which is finding 36 exactly",
  );

  assert.ok(
    route.includes('(employee.employmentStatus ?? "active") === "active" && employee.payrollEligible !== false'),
    "the full-month branch must stay restricted to employment_status 'active' — widening it to " +
      "anything else lets a terminal employee be paid an unprorated month",
  );

  // The two populations must stay disjoint. The terminal branch excludes anyone already counted as
  // active; without that a leaver could appear twice and be paid twice.
  assert.ok(
    route.includes("!activeHrIds.has(hrId)"),
    "the terminal branch must exclude HR ids already in the active population, or a leaver is paid twice",
  );

  // ---- 2. The status is written at FILING — the mechanism that closes finding 36 ----------------
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const definitions: { file: string; body: string }[] = [];
  for (const file of migrations) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const body of functionBodies(sql, `create or replace function ${RESIGN_RPC}`)) {
      definitions.push({ file, body });
    }
  }

  assert.ok(
    definitions.length > 0,
    `HEADLINE: no migration defines ${RESIGN_RPC} — either it was renamed or this test is looking ` +
      "in the wrong place, and either way finding 36's mechanism is no longer pinned by anything",
  );

  for (const { file, body } of definitions) {
    assert.ok(
      body.includes(STATUS_WRITE),
      `HEADLINE: ${file} redefines ${RESIGN_RPC} without writing "${STATUS_WRITE}" — filing a ` +
        "resignation must set employment_status immediately, not at workflow completion. Deferring " +
        "it leaves the employee 'active', and the Ready payroll sheet then pays that leaver a full " +
        "unprorated month (cycle 1 finding 36)",
    );
  }

  // ---- 3. The declined-offer shortcut lands inside the same terminal set ------------------------
  // Its includeInPayroll=true branch pays the days actually worked, which only happens if the
  // status it writes is one the Ready sheet counts as terminal.
  const declineRpc = migrations.find((name) => name.includes("phx_decline_offer_and_open_vacancy"));
  assert.ok(declineRpc, "the declined-offer RPC migration must exist");
  const declineSql = readFileSync(path.join(MIGRATIONS_DIR, declineRpc!), "utf8");
  assert.ok(
    declineSql.includes(STATUS_WRITE),
    "the declined-offer RPC must write employment_status too — its in-payroll branch depends on " +
      "landing inside terminalPayrollStatuses to be paid for the days worked",
  );
}
