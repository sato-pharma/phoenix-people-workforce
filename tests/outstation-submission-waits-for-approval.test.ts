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
  assert.match(
    submitSlice,
    /const workflowStatus\s*=\s*decisionStatus === "rejected_by_system"\s*\?\s*decisionStatus\s*:\s*"submitted"/,
    "a clean submission must persist as `submitted` so it lands in the pending queue",
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
      /notifyOutstationSubmitted\([\s\S]{0,160}heldForReview:\s*true/,
      `${signature} must raise the awaiting-approval alert itself, now that no approval fires it`,
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
