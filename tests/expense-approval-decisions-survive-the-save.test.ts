import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  expenseDecisionChanged,
  resolveExpenseDecisionWrite,
  type ExpenseApprovalDecision,
  type StoredExpenseDecision,
} from "../src/lib/outstation/approval-state.ts";
import { addPress, EMPTY_PRESS_QUEUE, pressBody, takeAll, takeDue } from "../src/lib/outstation/approvals/press-queue.ts";
import type { DeskClaim, DeskDecisionRequest } from "../src/lib/outstation/approvals/types.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Three ways an Expense Approvals decision reached the screen and never reached the row payroll
 * pays from. All three reported success, which is what makes them one family rather than three
 * bugs: a reviewer cannot tell a save that worked from a save that quietly wrote nothing.
 *
 * Found together on production ozucdzovmcqvepbozvqf, 2026-09-07, after an evening's review of a
 * ~400-row queue came back looking untouched.
 *
 *  1. THE SAVE PAYLOAD USED A NARROWER "CHANGED" TEST THAN THE SAVE BUTTON. The unsaved counter
 *     included the rejected/not-rejected term; the payload builder did not. So "Undo rejection"
 *     raised the black Save bar, entered no report id into `changedReportIds`, posted nothing,
 *     cleared the local decisions and reported "Approvals saved." — and the row came back rejected.
 *
 *  2. APPROVING AN APP-SUBMITTED REQUEST LEFT ITS PAYROLL ROW PENDING. The approve path relied on
 *     `approveOutstationRequestForPayroll` having pushed the row, but that push carries
 *     `preserveExistingDecision: true` — right for a figures-only re-push, and harmless when the
 *     trip reaches payroll for the first time, but a request that ALREADY had a pending
 *     `outstation_expenses` row keeps that pending decision. Four trips on 2026-09-07 (requests 38,
 *     39, 41, 55 — 2,859.17 EGP against the August payout) read Approved on every screen while the
 *     table payroll reads said otherwise. It also froze the `expense_claims` mirror for an hour:
 *     `expense_claims_approved_needs_decision` refuses an approved claim with no `decided_at`, and
 *     the rebuild is one transaction, so one row stops all of it.
 *
 *  3. LEAVING THE PAGE DISCARDED EVERY UNSAVED DECISION, SILENTLY. Since the 2026-11-23 rebuild
 *     there is no unsaved set: a press is sent by itself after six seconds of Undo, and leaving
 *     inside those seconds sends it at once (`takeAll`, `keepalive`). Section 4 pins that.
 *
 * WHY THE SHAPE. The suite has no module mocking, so the database round-trip cannot be executed.
 * The pure half is executed for real: the shared predicate, and the resolver that decides what a
 * save writes into the decision columns. The links that stay unexecuted — that both call sites use
 * the predicate, and that the approve path no longer skips its decisive write — are pinned against
 * source, because a correct helper nothing calls is exactly the shape of bugs 1 and 2.
 */

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function decision(overrides: Partial<ExpenseApprovalDecision> = {}): ExpenseApprovalDecision {
  return { approvedAmount: 665, hrApproved: false, hrComment: "", status: "", ...overrides };
}

function storedDecision(overrides: Partial<StoredExpenseDecision> = {}): StoredExpenseDecision {
  return {
    approvedAmount: null,
    approvedAt: null,
    approvedBy: null,
    hrApproved: false,
    hrComment: "",
    hrStatus: "",
    status: "",
    ...overrides,
  };
}

export function runExpenseApprovalDecisionsSurviveTheSaveTests() {
  // ── 1. The shared predicate ────────────────────────────────────────────────────────────────

  // THE HEADLINE. Undoing a rejection moves nothing but `status`: the trip was not approved before
  // and is not approved now, the payable figure is untouched, and the reason typed to justify the
  // rejection stays in the box. Every other term is therefore equal, and a predicate missing the
  // status term calls this "unchanged" — which is precisely how the decision was dropped.
  assert.equal(
    expenseDecisionChanged(
      decision({ hrComment: "Distance under the floor.", status: "" }),
      decision({ hrComment: "Distance under the floor.", status: "Rejected" }),
    ),
    true,
    "undoing a rejection is a change — it moves only `status`, and that is the whole bug",
  );

  // The mirror case, which is what made the narrow predicate look correct: rejecting a trip DOES
  // move the comment (a reason is mandatory), so bug 1 hid behind rejections that saved fine.
  assert.equal(
    expenseDecisionChanged(
      decision({ hrComment: "Distance under the floor.", status: "Rejected" }),
      decision({ hrComment: "", status: "" }),
    ),
    true,
    "rejecting a trip is a change",
  );

  assert.equal(
    expenseDecisionChanged(decision(), decision()),
    false,
    "an untouched trip is not a change — the queue posts its whole report on every save, and this " +
      "is what keeps a report nobody edited out of the payload",
  );

  assert.equal(
    expenseDecisionChanged(decision({ hrApproved: true }), decision()),
    true,
    "approving a trip is a change",
  );

  assert.equal(
    expenseDecisionChanged(decision({ approvedAmount: 500 }), decision({ approvedAmount: 665 })),
    true,
    "a reduced payable figure is a change",
  );

  // Same half-pound tolerance `isAdjustedAmount` uses: the figure round-trips through a number
  // input, so an exact compare would mark rows nobody touched as unsaved for ever.
  assert.equal(
    expenseDecisionChanged(decision({ approvedAmount: 665.4 }), decision({ approvedAmount: 665 })),
    false,
    "currency jitter under half a pound is not a change",
  );

  assert.equal(
    expenseDecisionChanged(decision({ hrComment: "Trimmed the fuel leg." }), decision()),
    true,
    "a written reason on its own is a change — it is the justification an employee is owed",
  );

  // Both spellings of a rejection are one state, so re-labelling must not read as a decision.
  assert.equal(
    expenseDecisionChanged(decision({ status: "Rejected" }), decision({ status: "rejected" })),
    false,
    "rejection is matched by meaning, not by literal — `isRejectedStatus` owns that rule",
  );

  // ── 2. Every caller uses it ────────────────────────────────────────────────────────────────

  // Rebuilt 2026-11-23 (approvals-desk/): the page no longer holds a set of unsaved decisions, so
  // bug 1 has no room left in it. A press IS the post: there is no "changed" test between the
  // button and the request that could be narrower than the button. The one place that still
  // compares a decision with what is stored is the imported sheet trips' save, and it must ask the
  // shared predicate.
  const importedHistory = readSource("../src/lib/outstation/imported-history.ts");
  assert.ok(
    importedHistory.includes("const changed = expenseDecisionChanged("),
    "the imported sheet trips' save decides what changed with the one shared predicate",
  );

  const deskHook = readSource("../src/components/outstation/approvals-desk/use-desk.ts");
  const pressQueue = readSource("../src/lib/outstation/approvals/press-queue.ts");

  // The exact comparison the two old call sites used to spell out by hand. If it comes back
  // anywhere on the page, a second "changed" test has been born and bug 1 is one term away.
  assert.doesNotMatch(
    deskHook + pressQueue,
    /local\.hrApproved !== saved\.hrApproved/,
    "no hand-rolled copy of the decision comparison may live on the desk",
  );

  // What is POSTED is the press itself, whole. Nothing filters it on the way out, so a decision
  // that was pressed can never be left out of the request the way a report id once was.
  assert.ok(
    pressQueue.includes("export function pressBody(press: DeskPress): { decisions: DeskDecisionRequest[] } {"),
    "the request body is built from the press in one place",
  );
  assert.ok(deskHook.includes("body: JSON.stringify(pressBody(press)),"), "and the page posts exactly that");
  const posted = pressBody(
    addPress(EMPTY_PRESS_QUEUE, {
      claims: [
        { requestId: 38, revision: "rev-38", standing: "rejected", total: 665 } as DeskClaim,
        { requestId: 39, revision: "rev-39", standing: "waiting", total: 700 } as DeskClaim,
      ],
      decisions: [
        { action: "approve", revision: "rev-38", requestId: 38 } as DeskDecisionRequest,
        { action: "reject", revision: "rev-39", comment: "Duplicate of another trip", requestId: 39 } as DeskDecisionRequest,
      ],
      now: 1_000,
    }).waiting[0],
  );
  assert.deepEqual(
    posted.decisions.map((entry) => `${entry.requestId}:${entry.action}`),
    ["38:approve", "39:reject"],
    "HEADLINE: undoing a rejection (approving a rejected claim) is posted like any other press: bug 1 was this press posting nothing",
  );

  // ── 3. An approve must carry the decision to the payroll row ───────────────────────────────

  // WHY THE APPROVE PATH CANNOT LEAN ON THE WORKFLOW RE-PUSH. This is bug 2, executed rather than
  // described: a preserving write over a stored PENDING row writes pending straight back, however
  // approved the incoming record says the trip is.
  const rePush = resolveExpenseDecisionWrite({
    approvedBy: "B-10",
    claimedTotal: 665,
    incoming: {
      approvedAmount: null,
      hrApproved: true,
      hrComment: "",
      hrStatus: "Approved",
      status: "Approved",
    },
    now: "2026-09-07T20:50:34.000Z",
    preserveExistingDecision: true,
    stored: storedDecision(),
  });
  assert.equal(
    rePush.hrApproved,
    false,
    "a preserving re-push keeps the stored pending decision — correct for a figures-only push, and " +
      "the reason an approve needs its own decisive write",
  );
  assert.equal(
    rePush.approvedAt,
    null,
    "and leaves `approved_at` null, which the claims mirror refuses",
  );

  const decisive = resolveExpenseDecisionWrite({
    approvedBy: "B-10",
    claimedTotal: 665,
    incoming: {
      approvedAmount: null,
      hrApproved: true,
      hrComment: "",
      hrStatus: "Approved",
      status: "Approved",
    },
    now: "2026-09-07T20:50:34.000Z",
    preserveExistingDecision: false,
    stored: storedDecision(),
  });
  assert.equal(decisive.hrApproved, true, "the decisive write lands the approval");
  assert.equal(
    decisive.approvedAt,
    "2026-09-07T20:50:34.000Z",
    "and stamps a decision time — `expense_claims_approved_needs_decision` requires one",
  );
  assert.equal(
    decisive.approvedAmount,
    null,
    "an untouched claim keeps a null approved_amount, so nothing invents a reduction",
  );

  const service = readSource("../src/lib/outstation/service.ts");

  // The guard that used to send a plain approve home before the decisive write.
  const skipGuard = service.match(/if \(plan\.action !== "amount"[\s\S]{0,160}?\) continue;/)?.[0];
  assert.ok(
    skipGuard,
    "applyOutstationRequestExpenseDecisions must still guard which plans skip the decisive write",
  );
  assert.match(
    skipGuard,
    /plan\.action !== "approve"/,
    "an approve must never be skipped — that skip is what left four trips approved on screen and " +
      "unapproved in `outstation_expenses` on 2026-09-07",
  );

  // ── 4. A decision survives leaving the page ────────────────────────────────────────────────
  //
  // Rebuilt 2026-11-23 (approvals-desk/; owner: "Save at once, with Undo"). There is no unsaved set
  // any more, so there is no draft to keep and no leave warning to raise: a press is sent by itself
  // six seconds later. The one window left is those six seconds, and leaving the page inside them
  // sends every press still waiting, with `keepalive` so the browser finishes the request after
  // the page is gone. Bug 3's rule is unchanged: a decision is never dropped in silence.
  const desk = stripComments(readSource("../src/components/outstation/approvals-desk/use-desk.ts"));

  assert.ok(
    desk.includes("const { due, queue } = closing ? takeAll(pressesRef.current) : takeDue(pressesRef.current, Date.now());"),
    "leaving takes EVERY press still inside its Undo window, not only the ones that are due",
  );
  assert.ok(desk.includes("keepalive: closing,"), "and sends them with keepalive, so the request outlives the page");
  assert.ok(desk.includes('window.addEventListener("pagehide", leave);'), "the tab closing sends them");
  assert.ok(
    desk.includes('document.addEventListener("visibilitychange", hidden);') && desk.includes('if (document.visibilityState === "hidden") flush(true);'),
    "a phone hiding the page sends them: pagehide alone is not reliable there",
  );
  assert.match(
    desk,
    /document\.removeEventListener\("visibilitychange", hidden\);\s*flush\(true\);\s*\};\s*\}, \[flush\]\);/,
    "and so does moving to another screen: the unmount sends them too",
  );

  // A permanently attached beforeunload makes the page ineligible for the back/forward cache, which
  // is why report-client-error.ts refuses to use one. Nothing here needs one.
  assert.ok(!desk.includes("beforeunload"), "the desk registers no beforeunload");
  assert.ok(
    !desk.includes("localStorage") && !desk.includes("sessionStorage"),
    "and keeps no decision in the browser: what is not sent yet is sent on the way out",
  );

  // The executed half: `takeAll` hands back every waiting press and leaves none behind.
  const first = addPress(EMPTY_PRESS_QUEUE, {
    claims: [{ requestId: 41, revision: "rev-41", standing: "waiting", total: 665 } as DeskClaim],
    decisions: [{ action: "approve", revision: "rev-41", requestId: 41 } as DeskDecisionRequest],
    now: 1_000,
  });
  assert.equal(takeDue(first, 1_001).due.length, 0, "inside the window nothing is due yet");
  const leavingNow = takeAll(first);
  assert.deepEqual(
    leavingNow.due.map((press) => press.decisions.map((entry) => entry.requestId)),
    [[41]],
    "HEADLINE: leaving the page one millisecond after a press still sends that press",
  );
  assert.equal(leavingNow.queue.waiting.length, 0, "and nothing is left waiting, so it cannot be sent twice");
}
