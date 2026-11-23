/**
 * Expense Approvals, rebuilt 2026-11-23 — ONE PRESS, pinned (owner: "Save at once, with Undo").
 *
 *   1. Approve, Reduce and Reject become the record the outstation workflow already applies; the
 *      version of the claim he saw travels with it.
 *   2. Refused BEFORE anything is written: a claim a payroll took, a press on an older version, a
 *      rejection or a reduced amount with no reason, an amount that is not lower than the claim.
 *   3. "Approve EGP 750" pays the idle-day cut only while the server's own reading still gives that
 *      figure; if a visit was recorded since, the row comes back instead.
 *   4. 🔴 A reduced amount on a trip the payroll gate would HOLD is refused: a held trip has no
 *      payroll row to carry the figure, and it would pay in full when released.
 *   5. The answer is read from the claim as stored afterwards — "saved" only when it stands where
 *      the press put it; a moved claim is "changed", anything else "refused".
 *   6. The system's verdict is kept with the decision, and the meter counts it: a Ready claim
 *      approved in full is agreement, a Ready claim reduced or rejected is a miss.
 *   7. decide.ts keeps the verdict without touching the claim's version token, a status or an
 *      amount, and refuses a preview session before it reads anything.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { AGREEMENT_WINDOW_DAYS, agreementLine, summarizeAgreement, verdictStamp } from "@/lib/outstation/approvals/agreement";
import { DESK_REFUSAL, decisionLanded, deskDecisionOutcome, planDeskDecision } from "@/lib/outstation/approvals/decision-plan";
import type { ClaimVerdict, DeskClaim, DeskDecisionRequest } from "@/lib/outstation/approvals/types";
import { OUTSTATION_CLAIM_CHANGED_CODE, OUTSTATION_CLAIM_CHANGED_MESSAGE } from "@/lib/outstation/claim-revision";
import { planOutstationRequestDecision } from "@/lib/outstation/expense-approval-decisions";

const REVISION = "2026-11-10T08:05:00.000Z";
const READY: ClaimVerdict = {
  checks: [{ answer: "pass", key: "field_work", label: "Field work", sentence: "Worked the day: 4 visits." }],
  idleDates: [],
  lane: "ready",
  reason: null,
};

function claim(over: Partial<DeskClaim> = {}): DeskClaim {
  return {
    allowance: 300,
    approvedAmount: null,
    daysWaiting: 13,
    decidedAt: null,
    employeeName: "Hossam Adel",
    employeeNote: null,
    employeeRole: "District Manager",
    from: "Minya",
    holdReason: null,
    hrComment: "",
    hrId: "PD-0015",
    locked: false,
    payable: 900,
    payoutMonth: 12,
    payoutYear: 2026,
    preCut: null,
    relatedRequestIds: [],
    requestId: 412,
    revision: REVISION,
    standing: "waiting",
    submittedAt: "2026-11-10T08:00:00.000Z",
    systemNote: null,
    to: "Asyut 2",
    total: 900,
    transportation: "Car",
    tripEnd: "2026-11-10",
    tripId: "OUTSTATION-412",
    tripStart: "2026-11-09",
    tripType: "traveling",
    verdict: READY,
    ...over,
  };
}

const press = (over: Partial<DeskDecisionRequest> = {}): DeskDecisionRequest => ({ action: "approve", requestId: 412, revision: REVISION, ...over });
const CUT = { deduction: 150, label: "Allowance for 1 idle day", payable: 750, reason: "Allowance deducted for the idle days: 1 of 2 days with no field activity." };

export function runExpenseDeskDecisionPlanTests() {
  // 1. The three presses.
  const approve = planDeskDecision(claim(), press());
  assert.deepEqual(approve, {
    approved: 900,
    ok: true,
    record: { approvedAmount: 900, hrApproved: true, hrComment: "", requestRevision: REVISION, status: "Approved", total: 900, tripId: "OUTSTATION-412" },
  });
  const reduce = planDeskDecision(claim(), press({ action: "reduce", approvedAmount: 600.004, comment: "  Ticket not attached.  " }));
  assert.deepEqual(reduce.ok && { amount: reduce.record.approvedAmount, approved: reduce.approved, comment: reduce.record.hrComment, hrApproved: reduce.record.hrApproved }, {
    amount: 600,
    approved: 600,
    comment: "Ticket not attached.",
    hrApproved: true,
  });
  const reject = planDeskDecision(claim(), press({ action: "reject", comment: "Duplicate of the claim of 9 Nov." }));
  assert.deepEqual(reject.ok && { approved: reject.approved, hrApproved: reject.record.hrApproved, status: reject.record.status }, {
    approved: null,
    hrApproved: false,
    status: "Rejected",
  });
  // The records mean to the workflow exactly what the press meant.
  const planOf = (plan: ReturnType<typeof planDeskDecision>) =>
    plan.ok
      ? planOutstationRequestDecision({
          claimedTotal: plan.record.total,
          currentStatus: "submitted",
          decision: plan.record,
          storedApprovedAmount: null,
        }).action
      : "not sent";
  assert.equal(planOf(approve), "approve");
  assert.equal(planOf(reduce), "approve");
  assert.equal(planOf(reject), "reject");

  // 2. Refused before anything is written.
  assert.deepEqual(planDeskDecision(null, press()), { code: "refused", message: DESK_REFUSAL.gone, ok: false });
  assert.deepEqual(planDeskDecision(claim({ locked: true, standing: "in_payroll" }), press()), { code: "refused", message: DESK_REFUSAL.locked, ok: false });
  assert.deepEqual(planDeskDecision(claim(), press({ revision: "2026-11-09T00:00:00.000Z" })), {
    code: "changed",
    message: OUTSTATION_CLAIM_CHANGED_MESSAGE,
    ok: false,
  });
  assert.equal(planDeskDecision(claim(), press({ revision: "" })).ok, false, "a press that names no version decides nothing");
  assert.deepEqual(planDeskDecision(claim(), press({ action: "reject", comment: "   " })), { code: "refused", message: DESK_REFUSAL.noRejectReason, ok: false });
  assert.deepEqual(planDeskDecision(claim(), press({ action: "reduce", approvedAmount: 600 })), { code: "refused", message: DESK_REFUSAL.noReduceReason, ok: false });
  for (const amount of [null, undefined, 0, -5, Number.NaN]) {
    assert.deepEqual(planDeskDecision(claim(), press({ action: "reduce", approvedAmount: amount, comment: "x" })), {
      code: "refused",
      message: DESK_REFUSAL.noAmount,
      ok: false,
    });
  }
  for (const amount of [900, 899.8, 1200]) {
    const refused = planDeskDecision(claim(), press({ action: "reduce", approvedAmount: amount, comment: "x" }));
    assert.equal(refused.ok, false, `${amount} is not a reduction of 900`);
    assert.match(refused.ok ? "" : refused.message, /must be lower than the claim \(EGP 900\)/);
  }

  // 3. The idle-day cut on the Approve button.
  const withCut = claim({ preCut: CUT, verdict: { ...READY, idleDates: ["2026-11-10"], lane: "your_call", reason: "No visit and no meeting on 1 of 2 days: 10 Nov." } });
  const cut = planDeskDecision(withCut, press({ approvedAmount: 750 }));
  assert.deepEqual(cut.ok && { amount: cut.record.approvedAmount, approved: cut.approved, comment: cut.record.hrComment }, {
    amount: 750,
    approved: 750,
    comment: CUT.reason,
  });
  assert.equal(planOf(cut), "approve", "a cut carries its reason, so the workflow does not refuse it as an unexplained deduction");
  const typed = planDeskDecision(withCut, press({ approvedAmount: 750, comment: "Second day at home." }));
  assert.equal(typed.ok && typed.record.hrComment, "Second day at home.", "his own words are never written over");
  const full = planDeskDecision(withCut, press());
  assert.equal(full.ok && full.record.approvedAmount, 900, "Keep full claim: an Approve with no amount pays the claim");
  assert.deepEqual(planDeskDecision(claim(), press({ approvedAmount: 750 })), { code: "changed", message: DESK_REFUSAL.cutMoved, ok: false });
  assert.deepEqual(planDeskDecision(withCut, press({ approvedAmount: 600 })), { code: "changed", message: DESK_REFUSAL.cutMoved, ok: false });

  // 4. A reduced amount a held trip could not carry.
  const willHold = { holdReason: "Waiting for the departure photo. Capture it before you leave the destination." };
  assert.deepEqual(planDeskDecision(claim(willHold), press({ action: "reduce", approvedAmount: 600, comment: "x" })), {
    code: "refused",
    message: DESK_REFUSAL.heldCannotReduce,
    ok: false,
  });
  assert.deepEqual(planDeskDecision(claim({ ...willHold, preCut: CUT }), press({ approvedAmount: 750 })), {
    code: "refused",
    message: DESK_REFUSAL.heldCannotReduce,
    ok: false,
  });
  assert.deepEqual(planDeskDecision(claim({ standing: "approved_held" }), press({ action: "reduce", approvedAmount: 600, comment: "x" })), {
    code: "refused",
    message: DESK_REFUSAL.heldCannotReduce,
    ok: false,
  });
  assert.equal(planDeskDecision(claim(willHold), press()).ok, true, "a held trip can still be approved in full");
  assert.equal(planDeskDecision(claim(willHold), press({ action: "reject", comment: "x" })).ok, true, "and rejected");

  // 5. The answer, read from the claim as stored afterwards.
  assert.equal(decisionLanded("approve", claim({ standing: "approved_queued" })), true);
  assert.equal(decisionLanded("reduce", claim({ standing: "approved_held" })), true);
  assert.equal(decisionLanded("approve", claim({ standing: "waiting" })), false);
  assert.equal(decisionLanded("reject", claim({ standing: "approved_queued" })), false);
  assert.equal(decisionLanded("reject", null), false);
  const saved = deskDecisionOutcome({ action: "approve", after: claim({ standing: "approved_queued" }), requestId: 412 });
  assert.deepEqual({ code: saved.code, message: saved.message }, { code: "saved", message: null });
  const heldOutcome = deskDecisionOutcome({
    action: "approve",
    after: claim({ standing: "approved_held" }),
    requestId: 412,
    skipped: { reason: "the trip was accepted, but the approval has not reached payroll — it is held out until its photos and workload land" },
  });
  assert.equal(heldOutcome.code, "saved", "an approval that is held DID land; it is said, never reported as a failure");
  assert.match(heldOutcome.message ?? "", /^The trip was accepted, but the approval has not reached payroll.*\.$/);
  assert.match(deskDecisionOutcome({ action: "approve", after: claim({ standing: "approved_held" }), requestId: 412 }).message ?? "", /Held out of payroll/);
  const moved = deskDecisionOutcome({
    action: "approve",
    after: claim(),
    requestId: 412,
    skipped: { code: OUTSTATION_CLAIM_CHANGED_CODE, reason: OUTSTATION_CLAIM_CHANGED_MESSAGE },
  });
  assert.equal(moved.code, "changed");
  assert.equal(moved.claim?.requestId, 412, "the claim comes back with its new figures");
  const failed = deskDecisionOutcome({ action: "reject", after: claim(), requestId: 412, skipped: { reason: "a rejection reason is required" } });
  assert.deepEqual({ code: failed.code, message: failed.message }, { code: "refused", message: "A rejection reason is required." });
  assert.equal(deskDecisionOutcome({ action: "approve", after: claim(), requestId: 412 }).message, DESK_REFUSAL.notSaved, "nothing landed and nothing was said: never 'saved'");

  // 6. The verdict kept, and the meter.
  const at = "2026-11-23T08:00:00.000Z";
  const stampOf = (action: "approve" | "reduce" | "reject", approved: number | null, verdict: ClaimVerdict = READY) =>
    verdictStamp({ action, approved, at, claimed: 900, verdict });
  assert.deepEqual(stampOf("approve", 900), { lane: "ready", stamp: { action: "approve", approved: 900, at, checks: READY.checks, claimed: 900, reason: null } });
  assert.equal(stampOf("reject", 900).stamp.approved, null, "a rejection approves nothing");
  const now = new Date("2026-11-24T08:00:00.000Z");
  const yourCall: ClaimVerdict = { ...READY, lane: "your_call", reason: "No departure photo." };
  const meter = summarizeAgreement(
    [
      stampOf("approve", 900),
      stampOf("approve", 900),
      stampOf("reduce", 600),
      stampOf("reject", null),
      stampOf("approve", 900, yourCall),
      stampOf("reject", null, yourCall),
      { lane: null, stamp: null },
      { lane: "ready", stamp: { ...stampOf("approve", 900).stamp, at: "2026-10-01T08:00:00.000Z" } },
      { lane: "ready", stamp: "not an object" },
    ],
    now,
  );
  assert.equal(AGREEMENT_WINDOW_DAYS, 30);
  assert.deepEqual(meter.ready, { approved: 2, decided: 4 }, "a Ready claim reduced or rejected is a miss; an unstamped or old one is not counted");
  assert.deepEqual(meter.yourCall, { approved: 1, decided: 2 });
  assert.equal(agreementLine(meter.ready), "2 of 4 (50%)");
  assert.equal(agreementLine({ approved: 0, decided: 0 }), "no decisions yet");

  // 7. decide.ts: what the verdict write may touch, and the order of its guards.
  const decide = fs.readFileSync("src/lib/outstation/approvals/decide.ts", "utf8");
  const updates = [...decide.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((match) => match[1].trim());
  assert.deepEqual(updates, ["system_lane_at_decision: lane, system_verdict_at_decision: stamp"], "the only write decide.ts makes itself is the two verdict columns");
  assert.ok(decide.includes('.is("system_lane_at_decision", null)'), "a claim already stamped is never stamped again");
  assert.ok(!/updated_at|approved_amount|payroll_month|\bstatus:/.test(decide.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "it never writes the version token, an amount or a status");
  assert.ok(
    decide.indexOf("assertRealSessionForDecision(access") < decide.indexOf("await loadDeskClaims("),
    "a preview session is refused before anything is read",
  );
  assert.ok(decide.includes("applyOutstationRequestExpenseDecisions("), "the money moves through the one existing function");
  assert.ok(!/phx_accept_outstation_claim_for_payroll|\.rpc\(/.test(decide), "decide.ts never calls the payroll write itself");
}
