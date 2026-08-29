import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { outstationStatusLabel } from "../src/lib/outstation/payroll-expense-mapping.ts";
import { expenseApprovalState } from "../src/lib/outstation/approval-state.ts";

// Owner question, 2026-08-08: "why am i not seeing all expense submitted in the expense approval?"
//
// Because they were never waiting for him. Submitting an outstation expense approved it into
// payroll in the same second: both submit paths called approveOutstationRequestForPayroll straight
// after the insert, which flipped the row to `accepted_by_system` and wrote a payroll row with
// hr_approved = true. Measured live that day: 21 of 29 requests (13,435.44 EGP) sat in the queue's
// APPROVED tab having never been read by a person, and the Pending tab held 2 — only the claims an
// automated check had refused to clear. The evidence gate, the workload gate and the CRM claim
// checks were all decision-support for a decision that had already been made.
//
// Owner decision, same day: "yes make it wait for my approval."
//
// NARROWED 2026-08-28 by a later owner rule: "Don't hold the expenses of the national sales
// manager for any reason. Once submitted, once accepted." A National Sales Manager's claim — and
// ONLY his — is accepted the moment he submits it and released into payroll (nsm-no-hold.ts). His
// hold could never have cleared on its own: the workload gate matches AM/PM visits out of the CRM
// and he runs no doctor list. Everything below still holds for every other role, and each
// assertion now also pins that the exception is exactly one role wide.
//
// WIDENED the same day, by PATH not by role: the owner extended it to createManagerExpenseAsAdmin
// too. His claim was instant when he filed it himself and queued when an admin filed it for him,
// which is the same money treated two ways for a reason that has nothing to do with him. The
// exception is still exactly ONE role; what changed is that both of his filing routes honour it.
//
// This pins the three things that have to stay true for that to hold. All by source inspection —
// the submit paths need Supabase, storage and a live geocoder, so the assertable surface is the
// wiring itself, the same approach outstation-expense-gate.test.ts takes for the payroll gate.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

/** One top-level function's body, from its signature to the next top-level function. */
function functionSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist — this test is pinned to it by name`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?async function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

export function runOutstationSubmissionWaitsForApprovalTests() {
  const service = readFileSync(SERVICE, "utf8");

  // ── 1. No submit path may approve its own claim ─────────────────────────────
  // The whole defect in one assertion: a function that both creates a claim and approves it has
  // removed the human from a money decision.
  const submitPaths = [
    "export async function submitOutstationRequest",
    "export async function submitMedicalRepSimpleExpenseRequest",
    "export async function createManagerExpenseAsAdmin",
  ];
  for (const signature of submitPaths) {
    const slice = functionSlice(service, signature);
    assert.doesNotMatch(
      slice,
      /approveOutstationRequestForPayroll\(/,
      `${signature} must not approve the claim it just created — approval belongs to a person, in the queue`,
    );
    assert.doesNotMatch(
      slice,
      /pushAcceptedOutstationExpenseToPayroll\(/,
      `${signature} must not push to payroll directly either — that is the same bypass one layer down`,
    );
  }

  // ── 2. A clean submission must persist as pending, not as accepted ──────────
  const submitSlice = functionSlice(service, "export async function submitOutstationRequest");
  // STRENGTHENED 2026-08-09 by owner decision ("do not reject any expense, you flag to admin and
  // he decides"): this used to allow one exception — `decisionStatus === "rejected_by_system"`
  // kept its own status. The submit path can no longer produce that verdict at all, so the
  // conditional is gone and EVERY submission lands in the pending queue. The intent is unchanged
  // and now absolute; outstation-decision.test.ts pins the other half, that no rule was deleted
  // in the process.
  assert.match(
    submitSlice,
    /const workflowStatus = noHoldRole \? "accepted_by_system" : "submitted";/,
    "every submission must persist as `submitted` so it lands in the pending queue — with exactly one exception, the owner's 2026-08-28 National Sales Manager rule. A second branch appearing here means somebody else stopped waiting for a human",
  );
  assert.match(
    submitSlice,
    /const noHoldRole = isOutstationNoHoldRole\(calculation\.employeeRole\);/,
    "…and that exception must come from the rule module, never from an inline role comparison that can drift away from it",
  );
  assert.match(
    submitSlice,
    /status:\s*workflowStatus,/,
    "the inserted row must carry the workflow status, not the calculation's own verdict",
  );
  assert.match(
    submitSlice,
    /calculation_status:\s*decisionStatus,/,
    "the calculation's verdict must still be recorded — 'passed every check' stays distinguishable " +
      "from 'held because a check could not run', it just no longer decides where the money goes",
  );

  // ── 3. Every submit path must still raise the alert itself ──────────────────
  // The alert used to ride along inside approveOutstationRequestForPayroll. Removing the
  // auto-approval without moving the mail would have silently stopped every submission email —
  // and left the approver with a queue nothing tells him about.
  for (const signature of submitPaths) {
    assert.match(
      functionSlice(service, signature),
      /notifyOutstationSubmitted\([\s\S]{0,160}heldForReview:\s*(?:true|!noHoldRole)/,
      `${signature} must raise the awaiting-approval alert itself, now that no approval fires it`,
    );
  }
  // Only ONE path may ever say the claim is not waiting, and only for the one reason.
  assert.match(
    submitSlice,
    /heldForReview: !noHoldRole,/,
    "the alert tells the truth on both sides of the rule: still 'waiting for you' for every role except the exempt one",
  );
  // The paths that honour the role rule, and the paths that have no exception at all.
  const noHoldPaths = submitPaths.filter(
    (path) => path.includes("submitOutstationRequest") || path.includes("createManagerExpenseAsAdmin"),
  );
  const strictPaths = submitPaths.filter((path) => !noHoldPaths.includes(path));
  assert.equal(
    noHoldPaths.length,
    2,
    "exactly two filing routes honour the rule — the employee's own submission and the admin's manual entry",
  );
  assert.ok(strictPaths.length > 0, "at least one submit path must remain with no exception at all");
  for (const signature of strictPaths) {
    assert.match(
      functionSlice(service, signature),
      /heldForReview:\s*true/,
      `${signature} has no exception — it waits for a human whoever the claim belongs to`,
    );
  }
  for (const signature of noHoldPaths) {
    assert.match(
      functionSlice(service, signature),
      // No trailing comma in the pattern: one path builds the options object across
      // several lines and the other on one, and the difference is formatting, not meaning.
      /heldForReview: !noHoldRole[,\s}]/,
      `${signature} must derive the alert from the role rule, never hard-code it either way`,
    );
  }
  // The admin path resolves the role ONCE and judges the claim against the same value it stores.
  const adminSlice = functionSlice(service, "export async function createManagerExpenseAsAdmin");
  assert.match(
    adminSlice,
    /const noHoldRole = isOutstationNoHoldRole\(employeeRole\);/,
    "the admin path's exception must come from the rule module, like the submit path's",
  );
  assert.match(
    adminSlice,
    /const adminWorkflowStatus = noHoldRole \? "accepted_by_system" : "submitted";/,
    "an admin-created claim still lands in the pending queue for every role but the exempt one",
  );
  assert.match(
    adminSlice,
    /employee_role: employeeRole,/,
    "the row must store the SAME role the rule was tested against — a second resolution can drift",
  );

  // The submit paths that now move money do it through the release function, which re-reads
  // the request and re-resolves the gate — and it must be reachable ONLY through the role rule.
  // An unguarded call here is the 2026-08-08 defect returning by another name.
  assert.match(
    submitSlice,
    /if \(noHoldRole\) \{[\s\S]{0,240}releaseOutstationRequestToPayrollIfReady\(/,
    "the payroll release at submit must sit behind the National Sales Manager rule and nothing else",
  );
  assert.match(
    adminSlice,
    /if \(noHoldRole\) \{[\s\S]{0,320}releaseOutstationRequestToPayrollIfReady\(/,
    "the admin path's payroll release must sit behind the role rule and nothing else",
  );
  for (const signature of strictPaths) {
    assert.doesNotMatch(
      functionSlice(service, signature),
      /releaseOutstationRequestToPayrollIfReady\(/,
      `${signature} must not release anything into payroll — no exception was granted to it`,
    );
  }

  // ── 4. The evidence-release path must not become a back door ────────────────
  // releaseOutstationRequestToPayrollIfReady pushes to payroll once a departure photo arrives.
  // It is only safe because it refuses anything not already accepted — which is now the ONLY
  // thing standing between "employee uploads his second photo" and "money moves unreviewed".
  const releaseSlice = functionSlice(service, "export async function releaseOutstationRequestToPayrollIfReady");
  assert.match(
    releaseSlice,
    /if \(!request\.status\.startsWith\("accepted"\)\)/,
    "the evidence release must refuse a still-pending request — otherwise uploading the departure " +
      "photo would push an unapproved claim into payroll and reopen the hole from the other side",
  );

  // ── 5. The queue must actually show it as pending ───────────────────────────
  // Guards the mapping the whole fix rests on: `submitted` has to read as Pending, and
  // `accepted_by_system` has to keep reading as Approved for the claims already decided.
  assert.equal(outstationStatusLabel("submitted"), "Pending");
  assert.equal(
    expenseApprovalState({ hrApproved: false, status: "submitted" }),
    "pending",
    "a waiting claim must land in the Pending tab, which is the whole point of the change",
  );
  assert.equal(outstationStatusLabel("accepted_by_system"), "Approved");
  assert.equal(outstationStatusLabel("rejected_by_system"), "Rejected");
  assert.equal(
    expenseApprovalState({ hrApproved: false, status: "rejected_by_system" }),
    "rejected",
    "a system rejection must not be mistaken for something awaiting a decision",
  );
}
