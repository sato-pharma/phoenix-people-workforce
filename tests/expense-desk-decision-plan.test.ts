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
import { amountLanded, DESK_REFUSAL, decisionLanded, deskDecisionOutcome, planDeskDecision } from "@/lib/outstation/approvals/decision-plan";
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
  const full = planDeskDecision(withCut, press({ keepFull: true }));
  assert.equal(full.ok && full.record.approvedAmount, 900, "Keep full claim, said out loud, pays the claim");
  // 🔴 A page read before the field work was (Phoenix CRM down when it loaded, or left open past
  // midnight) sends a plain Approve for a trip the server now finds an idle day on. Its silence
  // never pays that day in full: the claim goes back with the cut on its button.
  assert.deepEqual(
    planDeskDecision(withCut, press()),
    { code: "changed", message: DESK_REFUSAL.idleDayFound, ok: false },
    "HEADLINE: an Approve that names no amount and does not say keep-full is not paid in full when the server finds a cut",
  );
  assert.deepEqual(planDeskDecision(withCut, press({ keepFull: false })), { code: "changed", message: DESK_REFUSAL.idleDayFound, ok: false });
  assert.equal(planDeskDecision(claim(), press({ keepFull: true })).ok, true, "keep-full on a trip with no cut is a plain approval");
  const pennyCut = claim({ preCut: { ...CUT, deduction: 0.2, payable: 899.8 } });
  assert.equal(planDeskDecision(pennyCut, press()).ok, true, "a cut within half a pound of the claim is the claim: nothing to say out loud");
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
  assert.equal(planDeskDecision(claim(willHold), press()).ok, true, "a held trip can still be approved in full");
  assert.equal(planDeskDecision(claim({ ...willHold, preCut: CUT }), press({ keepFull: true })).ok, true, "and one with an idle day too, when its own row says it pays in full");
  assert.equal(planDeskDecision(claim(willHold), press({ action: "reject", comment: "x" })).ok, true, "and rejected");

  // 4b. 🔴 A DECIDED claim is never pressed again (owner's plan, 23 Nov: "No decided claim's money
  // moves"). The risk review of the first build traced History → Open → "Pay in full" on a claim he
  // had approved at EGP 900 of 1,200: it wrote the typed amount to NULL and payroll paid 1,200.
  // Every press on every decided standing is refused, with the right version and a reason.
  for (const standing of ["approved_held", "approved_queued", "rejected"] as const) {
    const decidedClaim = claim({ approvedAmount: standing === "approved_queued" ? 600 : null, standing });
    for (const attempt of [
      press(),
      press({ keepFull: true }),
      press({ action: "reduce", approvedAmount: 500, comment: "Second look." }),
      press({ action: "reject", comment: "Second look." }),
    ]) {
      assert.deepEqual(
        planDeskDecision(decidedClaim, attempt),
        { code: "refused", message: DESK_REFUSAL.decided, ok: false },
        `HEADLINE: ${attempt.action} on a claim that stands ${standing} is refused`,
      );
    }
    assert.deepEqual(
      planDeskDecision(decidedClaim, press({ revision: "an-older-version" })),
      { code: "refused", message: DESK_REFUSAL.decided, ok: false },
      "and no version of a decided claim gets a different answer",
    );
  }

  // 5. The answer, read from the claim as stored afterwards.
  assert.equal(decisionLanded("approve", claim({ standing: "approved_queued" })), true);
  assert.equal(
    decisionLanded("approve", claim({ standing: "approved_missed" })),
    true,
    "HEADLINE: approving a trip whose payout month's payroll already ran still landed — it must not read as not saved",
  );
  assert.equal(decisionLanded("reject", claim({ standing: "approved_missed" })), false);
  assert.equal(decisionLanded("reduce", claim({ standing: "approved_held" })), true);
  assert.equal(decisionLanded("approve", claim({ standing: "waiting" })), false);
  assert.equal(decisionLanded("reject", claim({ standing: "approved_queued" })), false);
  assert.equal(decisionLanded("reject", null), false);
  const saved = deskDecisionOutcome({ action: "approve", after: claim({ standing: "approved_queued" }), approved: 900, requestId: 412 });
  assert.deepEqual({ code: saved.code, message: saved.message }, { code: "saved", message: null });

  // 🔴 An approval is two writes: the claim, then its figure. The state can land while the figure
  // does not, and then payroll pays MORE than he chose. That is never "saved".
  assert.equal(amountLanded(900, claim({ standing: "approved_queued" })), true, "in full: no typed amount is stored");
  assert.equal(amountLanded(600, claim({ approvedAmount: 600, payable: 600, standing: "approved_queued" })), true);
  assert.equal(amountLanded(600, claim({ approvedAmount: null, standing: "approved_queued" })), false, "HEADLINE: reduced to 600, stored in full");
  assert.equal(amountLanded(600, claim({ approvedAmount: 650, payable: 650, standing: "approved_queued" })), false, "a different figure is not his figure");
  assert.equal(amountLanded(900, claim({ approvedAmount: 600, payable: 600, standing: "approved_queued" })), false, "approved in full, stored reduced");
  assert.equal(amountLanded(null, claim({ standing: "approved_queued" })), false);
  assert.equal(amountLanded(600, null), false);
  const lost = deskDecisionOutcome({ action: "reduce", after: claim({ approvedAmount: null, payable: 900, standing: "approved_queued" }), approved: 600, requestId: 412 });
  assert.deepEqual(
    { code: lost.code, message: lost.message },
    { code: "amount_not_saved", message: "Approved, but NOT at EGP 600: that amount was not saved. As it stands this trip pays EGP 900." },
    "HEADLINE: an approval whose reduced amount did not land says so, with what it pays as it stands",
  );
  const lostCut = deskDecisionOutcome({ action: "approve", after: claim({ approvedAmount: null, payable: 900, standing: "approved_held" }), approved: 750, requestId: 412 });
  assert.equal(lostCut.code, "amount_not_saved", "the idle-day cut is an amount too");
  assert.match(lostCut.message ?? "", /pays EGP 900 when it is released from its hold\.$/);
  // 🔴 Two tabs: A approves in full, B reduces. B's write is refused as stale, yet the claim now
  // reads approved. B did nothing, and must not be told its figure was saved.
  const twoTabs = deskDecisionOutcome({
    action: "reduce",
    after: claim({ standing: "approved_queued" }),
    approved: 600,
    requestId: 412,
    skipped: { code: OUTSTATION_CLAIM_CHANGED_CODE, reason: OUTSTATION_CLAIM_CHANGED_MESSAGE },
  });
  assert.equal(twoTabs.code, "changed", "HEADLINE: a press the workflow refused as stale is 'changed', even when the claim now reads approved");

  const heldOutcome = deskDecisionOutcome({
    action: "approve",
    after: claim({ standing: "approved_held" }),
    approved: 900,
    requestId: 412,
    skipped: { reason: "the trip was accepted, but the approval has not reached payroll — it is held out until its photos and workload land" },
  });
  assert.equal(heldOutcome.code, "saved", "an approval that is held DID land; it is said, never reported as a failure");
  assert.match(heldOutcome.message ?? "", /^The trip was accepted, but the approval has not reached payroll.*\.$/);
  assert.match(deskDecisionOutcome({ action: "approve", after: claim({ standing: "approved_held" }), approved: 900, requestId: 412 }).message ?? "", /Held out of payroll/);
  const moved = deskDecisionOutcome({
    action: "approve",
    after: claim(),
    approved: 900,
    requestId: 412,
    skipped: { code: OUTSTATION_CLAIM_CHANGED_CODE, reason: OUTSTATION_CLAIM_CHANGED_MESSAGE },
  });
  assert.equal(moved.code, "changed");
  assert.equal(moved.claim?.requestId, 412, "the claim comes back with its new figures");
  const failed = deskDecisionOutcome({ action: "reject", after: claim(), approved: null, requestId: 412, skipped: { reason: "a rejection reason is required" } });
  const rejected = deskDecisionOutcome({ action: "reject", after: claim({ payable: 0, standing: "rejected" }), approved: null, requestId: 412 });
  assert.equal(rejected.code, "saved", "a rejection has no figure to land");
  assert.deepEqual({ code: failed.code, message: failed.message }, { code: "refused", message: "A rejection reason is required." });
  assert.equal(deskDecisionOutcome({ action: "approve", after: claim(), approved: 900, requestId: 412 }).message, DESK_REFUSAL.notSaved, "nothing landed and nothing was said: never 'saved'");

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

  // 🔴 A batch never pays an idle day in full: refused on the server, counted AFTER a repeated claim
  // is dropped, and before the plan is even asked.
  assert.ok(decide.indexOf("presses.push(decision);") < decide.indexOf("const batch = presses.length > 1;"), "a batch is counted in claims, after the repeats are dropped");
  assert.ok(
    decide.includes("plan: batch && decision.keepFull === true ? keepFullInBatch : planDeskDecision(before.get(decision.requestId), decision),"),
    "HEADLINE: keep-full inside a request that decides more than one claim is refused",
  );
  assert.ok(decide.includes('const keepFullInBatch: PlannedDeskDecision = { code: "refused", message: DESK_REFUSAL.keepFullAlone, ok: false };'));

  // 🔴 The figure that did not land. The press is sent once more — only for a claim THIS press put
  // into the next payroll, never for one the workflow refused as stale — and the verdict is kept
  // only with an answer of "saved".
  const resend = decide.slice(decide.indexOf("const unfinished = sent.filter("), decide.indexOf("const outcomes: DeskDecisionOutcome[] = [];"));
  assert.ok(resend.includes('if (entry.decision.action === "reject" || !entry.claim || !stored || !awaitsAPayroll(stored.standing)) return false;'), "only an approval whose payroll row no payroll has taken is sent again");
  assert.ok(resend.includes("if (skippedByTrip.get(entry.claim.tripId)?.code === OUTSTATION_CLAIM_CHANGED_CODE) return false;"), "HEADLINE: never a press the workflow refused as stale — that claim is somebody else's decision");
  assert.ok(resend.includes("return !amountLanded(entry.plan.approved, stored);"), "and only where the stored figure is not the one chosen");
  assert.equal((decide.match(/await applyOutstationRequestExpenseDecisions\(/g) ?? []).length, 2, "the press, and at most one re-send: never a loop");
  assert.ok(!/\b(while|for\s*\(;;)/.test(resend.replace(/\/\/.*$/gm, "")), "the re-send does not repeat");
  assert.ok(resend.includes('event: "expense_desk_amount_resent"'), "a re-send is written to the error table");
  assert.match(
    decide,
    /const outcome = deskDecisionOutcome\(\{[\s\S]{0,260}?approved: plan\.approved,[\s\S]{0,260}?\}\);[\s\S]{0,400}?if \(claim && stored && outcome\.code === "saved"\) \{\s*const verdict = await keepVerdict\(/,
    "HEADLINE: the answer is read against the figure chosen, and the verdict is kept only with a decision that landed whole",
  );
}
