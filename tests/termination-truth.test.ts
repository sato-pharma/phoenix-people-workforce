import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// Terminations must tell the truth in two directions:
//   1. A company-decided exit (probation termination, contract non-renewal) must NOT be announced
//      to the resignation recipient list as a voluntary "Resignation Submitted".
//   2. Marking a resignation "completed" must actually end the employment — otherwise the record
//      says completed while the person stays active, payroll-eligible and able to log in.
export function runTerminationTruthTests() {
  const resignations = readFileSync("src/lib/resignations/service.ts", "utf8");
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
    ["contract non-renewal", contracts],
    ["probation intelligence decision", decision],
  ] as const) {
    // The call's OWN closing paren, at the indent the call opens on — a real end. 1400 bytes ran
    // well past every one of these three calls (they are 600-700), so the flag could have been
    // satisfied by a DIFFERENT call sitting below the one under test.
    const callAt = source.indexOf("resignEmployeeAndOpenVacancy(");
    const callIndent = /^ */.exec(source.slice(source.lastIndexOf("\n", callAt) + 1))![0];
    const callRest = source.slice(callAt);
    const callEnd = callRest.indexOf(`\n${callIndent});`);
    const call = callRest.slice(0, callEnd >= 0 ? callEnd : callRest.length);
    assert.ok(
      source.includes("resignEmployeeAndOpenVacancy("),
      `${label} must still route termination through the canonical helper`,
    );
    assert.match(
      call,
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

  // ── 3. "Completed" must also empty the seat ────────────────────────────────
  // Terminating the employee opens the replacement position_vacancies row (trigger
  // phx_employee_terminal_vacancy_guard) but touches nothing in the au model, so this path
  // used to leave the departed person still occupying their seat on the organogram. The
  // Employees-page path never had the gap: vacating is step 5 of
  // phx_resign_employee_and_open_vacancy, which complete deliberately cannot call (see 2).
  assert.match(
    workflow,
    /vacateAuSeatsIfSupported\(/,
    "completing a resignation must vacate the employee's au seat(s) — otherwise position_vacancies opens a " +
      "replacement while the organogram still shows the departed person sitting on the seat",
  );
  assert.match(
    resignations,
    /rpc\(\s*"phx_vacate_au_seats_for_employee"/,
    "vacateAuSeatsIfSupported must reach the au model through the public.phx_vacate_au_seats_for_employee " +
      "wrapper — the au schema is not exposed on PostgREST, so there is no direct route from TypeScript",
  );
}
