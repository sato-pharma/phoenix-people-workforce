import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// Terminations must tell the truth in two directions:
//   1. A company-decided exit (probation termination, contract non-renewal) must NOT be announced
//      to the resignation recipient list as a voluntary "Resignation Submitted".
//   2. Marking a resignation "completed" must actually end the employment — otherwise the record
//      says completed while the person stays active, payroll-eligible and able to log in.
export function runTerminationTruthTests() {
  const resignations = readFileSync("src/lib/resignations/service.ts", "utf8");
  const probation = readFileSync("src/lib/probation/service.ts", "utf8");
  const contracts = readFileSync("src/lib/contracts/service.ts", "utf8");
  const decision = readFileSync("src/lib/probation/intelligence/decision.ts", "utf8");

  // ── 1. The suppression contract ────────────────────────────────────────────
  // resignEmployeeAndOpenVacancy fires notifyResignationWorkflow ("Resignation Submitted") unless
  // the caller opts out. Every COMPANY-decided termination must opt out.
  assert.match(
    resignations,
    /options\?:\s*\{\s*suppressWorkflowNotification\?:\s*boolean\s*\}/,
    "resignEmployeeAndOpenVacancy must keep the suppressWorkflowNotification option — three callers depend on it",
  );

  for (const [label, source] of [
    ["probation termination", probation],
    ["contract non-renewal", contracts],
    ["probation intelligence decision", decision],
  ] as const) {
    const call = source.slice(source.indexOf("resignEmployeeAndOpenVacancy("));
    assert.ok(
      source.includes("resignEmployeeAndOpenVacancy("),
      `${label} must still route termination through the canonical helper`,
    );
    assert.match(
      call.slice(0, 1400),
      /suppressWorkflowNotification:\s*true/,
      `${label} is a company decision — it must pass suppressWorkflowNotification so the employee's chain is not told they resigned`,
    );
  }

  // ── 2. "Completed" must end the employment ─────────────────────────────────
  const workflow = resignations.slice(
    resignations.indexOf("export async function runResignationWorkflow"),
    resignations.indexOf("export async function runResignationSlaDaily"),
  );
  assert.ok(workflow.length > 0, "runResignationWorkflow must exist and precede runResignationSlaDaily");

  assert.match(
    workflow,
    /if \(action === "complete"\)/,
    "the complete action must do more than stamp the resignation row",
  );
  assert.match(
    workflow,
    /updateEmployeeLifecycleFallback\(/,
    "completing a resignation must write the employee's terminal lifecycle state (employment_status, payroll_eligible, last_working_date)",
  );
  assert.match(
    workflow,
    /deactivateEmployeeAccessIfSupported\(/,
    "completing a resignation must deactivate app_auth_users / user_access_profiles — otherwise the person can still log in",
  );
  // Must NOT call the full helper: that inserts a SECOND employee_resignations row via
  // phx_resign_employee_and_open_vacancy, duplicating the record being completed.
  assert.doesNotMatch(
    workflow,
    /resignEmployeeAndOpenVacancy\(/,
    "complete must not call resignEmployeeAndOpenVacancy — it would insert a duplicate resignation row for a record that already exists",
  );
}
