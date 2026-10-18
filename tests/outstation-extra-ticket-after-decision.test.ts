import assert from "node:assert/strict";
import { join } from "node:path";

import {
  OUTSTATION_CLAIM_DECIDED_MESSAGE,
  OUTSTATION_UNDECIDED_STATUSES,
  isOutstationClaimUndecided,
} from "../src/lib/outstation/undecided-claim.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// An extra ticket is refused once HR has decided the claim (owner, 2026-10-19: "after HR decision
// not able to add anything").
//
// THE HOLE. addExtraTicketsToOwnOutstationRequest refused only a status that began with "rejected".
// An employee could therefore add a ticket to an ACCEPTED claim that was not yet paid, and the
// function then re-pushed the new, higher total to the linked payroll row. HR's ordinary Approve
// stores no typed amount, so payroll pays the claim in full: the employee raised what was paid after
// the person who approved it had gone, and nobody saw the new figure. Nothing had moved through it
// in production when it was found (0 of 85 accepted claims carried an extra ticket).
//
// WHY THE SHAPE. The suite has no module mocking, so the database round-trip cannot be executed.
// Everything either side of it is: the allow-list is driven by behaviour, and the places that must
// call it - the function, its write, its route and the employee screen - are pinned against comment-
// stripped source, because a correct allow-list that nothing calls is exactly the shape of this bug.

const ROOT = process.cwd();
const SERVICE = "src/lib/outstation/service.ts";
const ROUTE = "app/api/outstation/[id]/extra-ticket/route.ts";
const DASHBOARD = "src/components/employee-portal/personal-expense-workload-dashboard.tsx";
const UNDECIDED = "src/lib/outstation/undecided-claim.ts";

/** A source file with its comments blanked: prose that QUOTES a call must not satisfy a pin on it. */
function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

/** One top-level function's body, from its signature to the next top-level async function. */
function functionSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist - this test is pinned to it by name`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?async function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

export function runOutstationExtraTicketAfterDecisionTests() {
  // -- the allow-list, by behaviour ---------------------------------------------------------------
  for (const open of ["submitted", "needs_review", " submitted "]) {
    assert.equal(isOutstationClaimUndecided(open), true, `"${open}" still waits for a person, so it takes a ticket`);
  }
  // Every status production holds today (read 2026-10-19) plus the ones the code names.
  for (const decided of [
    "accepted_by_admin",
    "accepted_by_system",
    "approved",
    "rejected_by_admin",
    "rejected_by_system",
  ]) {
    assert.equal(
      isOutstationClaimUndecided(decided),
      false,
      `HEADLINE: "${decided}" is decided - an extra ticket on it would change a figure HR already settled`,
    );
  }
  // Fail closed: a status nobody listed, a blank, a missing one and a different case are all decided.
  for (const unknown of ["", "   ", null, undefined, "SUBMITTED", "held", "accepted", "paid", 0, {}]) {
    assert.equal(
      isOutstationClaimUndecided(unknown),
      false,
      `${JSON.stringify(unknown)} must be treated as decided - a forgotten status can never reopen a claim`,
    );
  }
  assert.deepEqual(
    [...OUTSTATION_UNDECIDED_STATUSES],
    ["submitted", "needs_review"],
    "the open set is exactly the two statuses in which nobody has decided",
  );
  assert.match(
    OUTSTATION_CLAIM_DECIDED_MESSAGE,
    /HR has already decided this claim, so nothing can be added to it\. Ask HR if it needs changing\./,
    "the employee is told who can change it, in words",
  );

  // -- the one list lives in one place -------------------------------------------------------------
  const undecided = code(UNDECIDED);
  assert.equal(
    (undecided.match(/\["submitted",\s*"needs_review"\]/g) ?? []).length,
    1,
    "the open statuses are written once, in undecided-claim.ts",
  );
  const service = code(SERVICE);
  assert.equal(
    /\["submitted",\s*"needs_review"\]/.test(service),
    false,
    "service.ts must not carry its own copy of the open statuses - a second list is how the two drift apart",
  );
  assert.match(
    service,
    /const JOURNEY_STOP_OPEN_STATUSES = OUTSTATION_UNDECIDED_STATUSES;/,
    "a journey stop and an extra ticket obey the same list",
  );

  // -- the function: guard before anything is uploaded or written ------------------------------------
  const fn = functionSlice(service, "export async function addExtraTicketsToOwnOutstationRequest(");
  const guard = fn.search(/if\s*\(\s*!isOutstationClaimUndecided\(existing\.status\)\s*\)\s*\{\s*throw new Error\(OUTSTATION_CLAIM_DECIDED_MESSAGE\);?\s*\}/);
  assert.notEqual(
    guard,
    -1,
    "HEADLINE: addExtraTicketsToOwnOutstationRequest must refuse a decided claim with the decided message",
  );
  const upload = fn.indexOf("uploadOutstationTicketAttachments(");
  const update = fn.indexOf(".update(");
  assert.ok(upload > guard, "the refusal comes BEFORE the files are uploaded - nothing is stored for a refused ticket");
  assert.ok(update > guard, "the refusal comes BEFORE the claim is written");
  assert.ok(
    fn.indexOf('.in("status", [...OUTSTATION_UNDECIDED_STATUSES])') > update,
    "the write is a gate too: HR deciding between the read and the update leaves no row to change",
  );
  for (const forbidden of [
    "syncLinkedOutstationPayrollExpense",
    "savePayrollExpenseApprovals",
    "pushAcceptedOutstationExpenseToPayroll",
    "releaseOutstationRequestToPayrollIfReady",
  ]) {
    assert.equal(
      fn.includes(forbidden),
      false,
      `HEADLINE: an extra ticket must never reach payroll - ${forbidden} does not belong in this function`,
    );
  }

  // -- the route answers 409, not a 500 -------------------------------------------------------------
  const route = code(ROUTE);
  assert.match(
    route,
    /import \{ OUTSTATION_CLAIM_DECIDED_MESSAGE \} from "@\/lib\/outstation\/undecided-claim";/,
    "the route compares against the shared message, not a copy of its words",
  );
  const status = /function extraTicketStatus[\s\S]*?\n\}\n/.exec(route)?.[0] ?? "";
  assert.notEqual(status, "", "extraTicketStatus must exist - the route's only mapping from a refusal to a status");
  const conflict = status.indexOf("error.message === OUTSTATION_CLAIM_DECIDED_MESSAGE");
  assert.notEqual(conflict, -1, "the decided message must be mapped by the route");
  assert.match(
    status.slice(conflict, conflict + 90),
    /\)\s*return 409;/,
    "a decided claim is a conflict with its current state (409)",
  );
  assert.ok(
    conflict < status.indexOf('message.includes("required")'),
    "mapped before the generic 400 text checks, or a rewording of the message would turn it into a 500",
  );

  // -- the employee screen offers the button only while the claim is waiting ---------------------------
  const dashboard = code(DASHBOARD);
  const eligible = /function extraTicketEligibleId[\s\S]*?\n\}\n/.exec(dashboard)?.[0] ?? "";
  assert.notEqual(eligible, "", "extraTicketEligibleId must exist - the screen's only gate on the button");
  assert.match(
    eligible,
    /mapStatusCategory\(trip\.status\)\s*!==\s*"Pending"/,
    "the button is offered only on a Pending claim",
  );
  assert.equal(
    /=== "Declined"/.test(eligible),
    false,
    "the old Declined-only test offered the button on every approved claim",
  );
}
