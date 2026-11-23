/**
 * Expense Approvals — CHANGING A CLAIM THAT WAS ALREADY DECIDED, pinned.
 *
 * Owner, 23 Nov 2026 (about 21:05 Cairo): "make me able to reject even if approved in history. Make
 * me easily able to approve or reject." That lifted the desk's rule of the same day, "decided trips
 * read-only", for two presses and no other.
 *
 *   1. One rule says what can still be pressed on a decided claim (`decidedChange`): an approved
 *      claim no payroll has taken → Reject; a rejected claim → Approve; a claim a payroll took, or
 *      whose payout month's payroll already ran → nothing, with the reason in words.
 *   2. The server obeys the same rule. An approved claim is rejected with a reason and nothing
 *      else: approving it again, keeping it full or reducing it is refused (the press that once
 *      wrote a typed amount to nothing). A rejected claim is approved IN FULL: a named lower amount
 *      is refused, and so is a second rejection.
 *   3. 🔴 A claim whose payout month's payroll already ran is not changed here by any press, on any
 *      version: unstamped is not unpaid.
 *   4. A changeable decided claim still answers "changed" to a press made on an older version.
 *   5. Approving a rejected claim never carries the idle-day cut, and keeps a reason that is true.
 *   6. The verdict kept for the agreement meter belongs to the FIRST decision: a change from History
 *      stamps nothing.
 *   7. Approving a claim the Super Admin rejected himself sends nobody the submission alert.
 *   8. The screen: the buttons are on the History row and in the opened trip, they are the desk's
 *      own, a row inside a press draws none, and the pre-July sheet trips stay read-only.
 *   9. 🔴 Both presses are also refused when the payout month's own payroll run has its second part
 *      confirmed, is published, cannot be read, or the month is before the paid stamps were kept —
 *      read by decide.ts before anything is written (risk review of this change, 23 Nov 2026: a
 *      rejection after the second part was confirmed deleted the row and the trip was still paid).
 *  10. A rejected claim names the figure payroll will pay: the claim as it is now, never a row left
 *      behind by its rejection.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { APPROVED_AFTER_REJECTION_NOTE, DECIDED_CHANGE_REFUSAL, decidedChange, decidedChangeRunRefusal } from "@/lib/outstation/approvals/decided-change";
import { DESK_REFUSAL, planDeskDecision } from "@/lib/outstation/approvals/decision-plan";
import { approvePress, approveRejectedPress } from "@/lib/outstation/approvals/desk-view";
import { TRIP_STANDINGS } from "@/lib/outstation/approvals/standing";
import type { ClaimVerdict, DeskClaim, DeskDecisionRequest } from "@/lib/outstation/approvals/types";
import { OUTSTATION_CLAIM_CHANGED_MESSAGE } from "@/lib/outstation/claim-revision";

const code = (file: string) => fs.readFileSync(file, "utf8");
const screen = (file: string) => code(`src/components/outstation/approvals-desk/${file}`);

const REVISION = "2026-11-10T08:05:00.000Z";
const READY: ClaimVerdict = {
  checks: [{ answer: "pass", key: "field_work", label: "Field work", sentence: "Worked the day: 4 visits." }],
  idleDates: [],
  lane: "ready",
  reason: null,
};
const CUT = { deduction: 150, label: "Allowance for 1 idle day", payable: 750, reason: "Allowance deducted for the idle days: 1 of 2 days with no field activity." };

function claim(over: Partial<DeskClaim> = {}): DeskClaim {
  return {
    allowance: 300,
    approvedAmount: null,
    daysWaiting: 13,
    decidedAt: "2026-11-12T09:00:00.000Z",
    employeeName: "Hossam Adel",
    employeeNote: null,
    employeeRole: "District Manager",
    from: "Minya",
    holdReason: null,
    hrComment: "",
    hrId: "PD-0015",
    kind: "traveling",
    locked: false,
    payable: 900,
    payoutMonth: 12,
    payoutYear: 2026,
    preCut: null,
    relatedRequestIds: [],
    requestId: 412,
    revision: REVISION,
    standing: "approved_queued",
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
const refused = (message: string) => ({ code: "refused", message, ok: false });

export function runExpenseDeskDecidedChangeTests() {
  // ── 1. The one rule ─────────────────────────────────────────────────────────────────────────
  assert.deepEqual(decidedChange({ locked: false, standing: "waiting" }), { offer: null, why: null }, "a waiting claim is decided by the desk's own four presses, not here");
  assert.deepEqual(decidedChange({ locked: false, standing: "approved_held" }), { offer: "reject", why: null }, "HEADLINE: an approved claim held out of payroll can be rejected");
  assert.deepEqual(decidedChange({ locked: false, standing: "approved_queued" }), { offer: "reject", why: null }, "HEADLINE: an approved claim waiting for the next payroll can be rejected");
  assert.deepEqual(decidedChange({ locked: false, standing: "rejected" }), { offer: "approve", why: null }, "HEADLINE: a rejected claim can be approved");
  assert.deepEqual(decidedChange({ locked: false, standing: "in_payroll" }), { offer: null, why: DECIDED_CHANGE_REFUSAL.inPayroll }, "a claim a payroll took is closed, and says so");
  assert.deepEqual(
    decidedChange({ locked: false, standing: "approved_missed" }),
    { offer: null, why: DECIDED_CHANGE_REFUSAL.payrollRan },
    "HEADLINE: a claim whose payout month's payroll already ran is closed: not marked paid is not the same as not paid",
  );
  for (const standing of TRIP_STANDINGS) {
    if (standing === "waiting") continue;
    assert.deepEqual(decidedChange({ locked: true, standing }), { offer: null, why: DECIDED_CHANGE_REFUSAL.inPayroll }, `a locked claim that stands ${standing} offers nothing`);
  }
  assert.match(DECIDED_CHANGE_REFUSAL.payrollRan, /Check the payroll Expenses step/, "the closed claim names the screen where its money is settled");

  // ── 2. An APPROVED claim: Reject, with a reason, and nothing else ───────────────────────────
  for (const standing of ["approved_held", "approved_queued"] as const) {
    const approved = claim({ approvedAmount: standing === "approved_queued" ? 600 : null, payable: standing === "approved_queued" ? 600 : 900, standing });
    assert.deepEqual(
      planDeskDecision(approved, press({ action: "reject", comment: "  The ticket is for another day.  " })),
      {
        approved: null,
        ok: true,
        record: { approvedAmount: 900, hrApproved: false, hrComment: "The ticket is for another day.", requestRevision: REVISION, status: "Rejected", total: 900, tripId: "OUTSTATION-412" },
      },
      `HEADLINE: rejecting a claim that stands ${standing} is the workflow's own rejection, with his reason`,
    );
    assert.deepEqual(planDeskDecision(approved, press({ action: "reject" })), refused(DESK_REFUSAL.noRejectReason), "a rejection still needs a reason");
    assert.deepEqual(planDeskDecision(approved, press({ action: "reject", comment: "   " })), refused(DESK_REFUSAL.noRejectReason));
    for (const attempt of [
      press(),
      press({ keepFull: true }),
      press({ approvedAmount: 750 }),
      press({ action: "reduce", approvedAmount: 500, comment: "Second look." }),
    ]) {
      assert.deepEqual(
        planDeskDecision(approved, attempt),
        refused(DECIDED_CHANGE_REFUSAL.approvedOnlyReject),
        `HEADLINE: ${attempt.action} on a claim that stands ${standing} is refused — it once wrote his typed amount to nothing`,
      );
    }
    // 4. The version he saw still travels with the press.
    assert.deepEqual(
      planDeskDecision(approved, press({ action: "reject", comment: "x", revision: "an-older-version" })),
      { code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, ok: false },
      "a press made on an older version of a decided claim comes back as changed",
    );
  }

  // ── 2b. A REJECTED claim: Approve, in full, and nothing else ────────────────────────────────
  const rejected = claim({ hrComment: "No field activity was recorded on the day of this trip.", payable: 0, standing: "rejected" });
  assert.deepEqual(
    planDeskDecision(rejected, press()),
    {
      approved: 900,
      ok: true,
      record: { approvedAmount: 900, hrApproved: true, hrComment: APPROVED_AFTER_REJECTION_NOTE, requestRevision: REVISION, status: "Approved", total: 900, tripId: "OUTSTATION-412" },
    },
    "HEADLINE: approving a rejected claim approves the claim in full, and the old rejection reason does not stay on it as the reason it was approved",
  );
  const withReason = planDeskDecision(rejected, press({ comment: " The photos arrived late. " }));
  assert.ok(withReason.ok && withReason.record.hrComment === "The photos arrived late.", "a reason he typed is kept instead of the standing sentence");
  assert.equal(planDeskDecision(rejected, press({ approvedAmount: 900 })).ok, true, "naming the claim's own total is still in full");
  // 5. Never the idle-day cut: it is read for a waiting claim only.
  const rejectedWithCut = claim({ preCut: CUT, standing: "rejected" });
  const full = planDeskDecision(rejectedWithCut, approveRejectedPress(rejectedWithCut));
  assert.ok(full.ok && full.approved === 900, "HEADLINE: a rejected claim with an idle day is approved at its total, not at a cut nobody re-read");
  assert.deepEqual(approveRejectedPress(rejectedWithCut), { action: "approve", requestId: 412, revision: REVISION }, "its press names no amount and no keep-full");
  assert.equal(approvePress(rejectedWithCut).approvedAmount, 750, "which is why History does not send the waiting lane's own Approve press");
  for (const attempt of [
    press({ approvedAmount: 750 }),
    press({ action: "reduce", approvedAmount: 500, comment: "Half of it." }),
    press({ action: "reject", comment: "Again." }),
  ]) {
    assert.deepEqual(planDeskDecision(rejected, attempt), refused(DECIDED_CHANGE_REFUSAL.rejectedOnlyApprove), `HEADLINE: ${attempt.action} with an amount, or a second rejection, is refused on a rejected claim`);
  }
  assert.deepEqual(planDeskDecision(rejected, press({ revision: "an-older-version" })), { code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, ok: false });

  // ── 3. Closed claims: no press, on no version ───────────────────────────────────────────────
  const closed: Array<[DeskClaim, string]> = [
    [claim({ standing: "approved_missed" }), DECIDED_CHANGE_REFUSAL.payrollRan],
    [claim({ standing: "in_payroll" }), DECIDED_CHANGE_REFUSAL.inPayroll],
    [claim({ locked: true, standing: "in_payroll" }), DECIDED_CHANGE_REFUSAL.inPayroll],
    [claim({ locked: true, standing: "approved_queued" }), DECIDED_CHANGE_REFUSAL.inPayroll],
  ];
  for (const [closedClaim, why] of closed) {
    for (const attempt of [
      press(),
      press({ keepFull: true }),
      press({ action: "reduce", approvedAmount: 500, comment: "x" }),
      press({ action: "reject", comment: "x" }),
      press({ action: "reject", comment: "x", revision: "an-older-version" }),
    ]) {
      assert.deepEqual(planDeskDecision(closedClaim, attempt), refused(why), `HEADLINE: ${attempt.action} on a claim that stands ${closedClaim.standing} is refused, whatever its version`);
    }
  }
  assert.equal(DESK_REFUSAL.locked, DECIDED_CHANGE_REFUSAL.inPayroll, "the desk and the rule say one sentence for a claim a payroll took");
  assert.equal(planDeskDecision(claim({ decidedAt: null, standing: "waiting" }), press()).ok, true, "a waiting claim is decided as before");

  // ── 6. The verdict belongs to the first decision ────────────────────────────────────────────
  const decide = code("src/lib/outstation/approvals/decide.ts");
  assert.ok(
    decide.includes('if (claim && stored && outcome.code === "saved" && claim.standing === "waiting") {'),
    "HEADLINE: a change from History stamps no verdict — the agreement meter keeps the first decision",
  );
  assert.equal((decide.match(/keepVerdict\(\{/g) ?? []).length, 1, "and there is one place a verdict is kept");
  const plan = code("src/lib/outstation/approvals/decision-plan.ts");
  assert.ok(
    plan.indexOf("const again = claim.standing === \"waiting\" ? null : decidedChange(claim);") < plan.indexOf("if (!decision.revision || decision.revision !== claim.revision)"),
    "a closed claim is refused before its version is read, so no version of it gets a different answer",
  );

  // ── 7. Nobody is told a twice-reviewed claim was "submitted" ────────────────────────────────
  const service = code("src/lib/outstation/service.ts");
  assert.match(
    service,
    /if \(existing\.status === "rejected_by_system"\) \{\s*await afterResponse\("outstation_notice:override", \(\) => notifyOutstationSubmitted\(request\)\);/,
    "HEADLINE: the submission alert on an approval is for a claim the SYSTEM rejected, never one the Super Admin rejected himself",
  );
  assert.match(
    service,
    /actionKey: existing\.status\.startsWith\("accepted"\) \? "reject_before_payroll" : "reject"/,
    "rejecting an approved claim is the workflow's own reject-before-payroll step, which this change re-implements nothing of",
  );

  // ── 8. The screen ───────────────────────────────────────────────────────────────────────────
  const decision = screen("desk-decision.tsx");
  assert.ok(decision.includes('{again === "approve" ? (') && decision.includes('{again === "reject" ? ('), "the shared buttons draw a decided claim's one button");
  assert.ok(
    decision.includes(': "The employee is told this reason. The claim leaves the next payroll."'),
    "rejecting an approved claim says what happens to its money before the press",
  );
  assert.ok(decision.includes('const cut = claim.standing === "waiting" ? claim.preCut : null;'), "and the reason box offers no idle-day figure for a decided claim");

  const row = screen("desk-history-row.tsx");
  assert.equal((row.match(/<RowDecision \{\.\.\.props\} mode=\{mode\} onMode=\{setMode\} size="(?:dense|regular)" \/>/g) ?? []).length, 2, "HEADLINE: the decision is on the History row itself, on a desktop and on a phone");
  assert.ok(
    row.includes("<DecisionButtons canDecide={canDecide && !pressed} claim={claim} mode={mode} onMode={onMode} onOpen={() => onOpen(claim.requestId)} onPress={onPress} size={size} />"),
    "HEADLINE: the buttons are the desk's own, and a row inside a press draws no decision button",
  );
  assert.equal((row.match(/\{mode !== "idle" && !pressed \? \(/g) ?? []).length, 2, "the reason opens joined to its row, and closes while a press is out");
  assert.ok(row.includes('<TableRowDetail colSpan={5} id={panelId}>'), "on a desktop the reason is the row's own panel, never a second row");
  assert.ok(row.includes("data-history-pressed"), "a row inside a press says its decision is being saved");
  assert.ok(!/\bfetch\(|useEffect/.test(row), "a History row sends nothing by itself: the press goes through the page's one queue, with its Undo");

  const history = screen("desk-history.tsx");
  for (const part of ["<HistoryCard ", "<HistoryTableRow "]) {
    assert.ok(
      history.includes(`${part}canDecide={canDecide} claim={claim} key={claim.requestId} onOpen={onOpen} onPress={onPress} pressed={pressed.has(claim.requestId)} />`),
      `${part.trim()} is handed the page's press and whether its claim is inside one`,
    );
  }
  const sheets = history.slice(history.indexOf("function SheetTrips()"));
  assert.ok(history.includes("<SheetTrips />") && sheets.length > 0, "the sheet trips take nothing from the page");
  assert.ok(!/onPress|onOpen|DecisionButtons|HistoryTableRow|<button\b/.test(sheets), "HEADLINE: the pre-July sheet trips stay read-only — nothing here decides one");

  const workspace = screen("desk-workspace.tsx");
  const mount = workspace.slice(workspace.indexOf("<DeskHistory"), workspace.indexOf("/>", workspace.indexOf("<DeskHistory")));
  for (const prop of ["canDecide={canDecide}", "onPress={desk.press}", "pressed={desk.pressed}", "version={desk.historyVersion}"]) {
    assert.ok(mount.includes(prop), `History is mounted with ${prop}`);
  }

  const file = screen("desk-trip-file.tsx");
  assert.ok(file.includes("const change = decidedChange(claim);") && file.includes("const again = canDecide ? change.offer : null;"), "the opened trip asks the same rule");
  assert.ok(
    file.includes('{mode !== "idle" && canDecide && !claim.locked && (waiting || again === "reject") && !pressed ? ('),
    "the opened trip's reason box opens for a waiting claim and for an approved one being rejected",
  );
  assert.ok(file.includes(") : !waiting && !again ? ("), "a decided claim with nothing to press reads its standing");
  assert.ok(file.includes('{TRIP_STANDING_MEANING[claim.standing]} {change.why ?? "It is read here, not changed."}'), "HEADLINE: and says WHY nothing can be pressed on it");

  // ── 9. The payout month's own payroll run ──────────────────────────────────────────────────
  const open = { part2Confirmed: false, published: false };
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 12, payoutYear: 2026, run: open }), null, "a month whose run is still in its first part, or not started, leaves both presses open");
  assert.equal(
    decidedChangeRunRefusal({ payoutMonth: 12, payoutYear: 2026, run: { part2Confirmed: true, published: false } }),
    DECIDED_CHANGE_REFUSAL.part2Confirmed,
    "HEADLINE: a run whose second part is confirmed refuses the change — its expense figures are frozen, and a rejection there was still paid",
  );
  assert.match(DECIDED_CHANGE_REFUSAL.part2Confirmed, /Reopen the second part in Automated Payroll/, "and names the screen to reopen it");
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 10, payoutYear: 2026, run: { part2Confirmed: true, published: true } }), DECIDED_CHANGE_REFUSAL.payrollRan, "HEADLINE: a published month refuses the change: no later run pays an earlier payout month");
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 8, payoutYear: 2026, run: open }), DECIDED_CHANGE_REFUSAL.payrollRan, "HEADLINE: August 2026 and before were paid before the stamps were kept — approving into them is paid by nobody");
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 3, payoutYear: 2025, run: open }), DECIDED_CHANGE_REFUSAL.payrollRan);
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 9, payoutYear: 2026, run: open }), null, "September 2026 is read from its run, not assumed paid");
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 12, payoutYear: 2026, run: null }), DECIDED_CHANGE_REFUSAL.runUnread, "HEADLINE: a run that could not be read refuses: money is not moved on a guess");
  assert.equal(decidedChangeRunRefusal({ payoutMonth: null, payoutYear: 2026, run: open }), DECIDED_CHANGE_REFUSAL.noPayoutMonth, "a claim with no payout month is refused");
  assert.equal(decidedChangeRunRefusal({ payoutMonth: 13, payoutYear: 2026, run: open }), DECIDED_CHANGE_REFUSAL.noPayoutMonth);

  const gate = decide.slice(decide.indexOf("const runs = new Map<string, Promise<PayoutRunReading>>();"), decide.indexOf("const sent = planned.filter("));
  assert.ok(gate.length > 0 && decide.indexOf("const runs = new Map") < decide.indexOf("await applyOutstationRequestExpenseDecisions("), "HEADLINE: the run is read before anything is written");
  assert.ok(gate.includes('if (!entry.plan.ok || !entry.claim || entry.claim.standing === "waiting") continue;'), "it is asked for a change to a DECIDED claim, and a waiting claim is decided as before");
  assert.ok(gate.includes("const refusal = decidedChangeRunRefusal({ payoutMonth, payoutYear, run });") && gate.includes('if (refusal) entry.plan = { code: "refused", message: refusal, ok: false };'), "a refusal replaces the plan, so nothing of it is sent");
  assert.ok(decide.includes("const [active, published] = await Promise.all([findActiveRun(month, year), findPublishedRun(month, year)]);"), "the second part is read from the active run and the publication from the published one");
  assert.ok(decide.includes("return { part2Confirmed: Boolean(active?.part2ConfirmedAt), published: published !== null };"));
  assert.match(decide, /catch \(error\) \{\s*logError\("The payroll run of a decided expense claim could not be read[\s\S]{0,260}?return null;/, "a failed read is logged and answers null, which refuses");

  // ── 10. A rejected claim names what payroll will pay ───────────────────────────────────────
  const claimRow = code("src/lib/outstation/approvals/claim-row.ts");
  assert.ok(claimRow.includes('const live = waiting || reading.standing === "rejected";'), "HEADLINE: a rejected claim reads its figures from the claim as it is now, not from the row its rejection left behind");
  assert.ok(claimRow.includes("const total = live ? approval.total : (ledger?.total ?? approval.total);") && claimRow.includes("const approvedAmount = live ? null : (ledger?.approved_amount ?? null);"));
}
