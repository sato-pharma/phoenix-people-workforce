import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  expenseDecisionChanged,
  resolveExpenseDecisionWrite,
  type ExpenseApprovalDecision,
  type StoredExpenseDecision,
} from "../src/lib/outstation/approval-state.ts";

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
 *  3. LEAVING THE PAGE DISCARDED EVERY UNSAVED DECISION, SILENTLY. Not covered by assertions on
 *     behaviour — it is UI state, not domain logic — but the workspace pins below check that the
 *     two mechanisms which fix it stay wired: the draft in `localStorage`, and the leave warning.
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

  // ── 2. Both call sites use it ──────────────────────────────────────────────────────────────

  const workspace = readSource("../src/components/outstation/expense-approvals-workspace.tsx");

  assert.ok(
    (workspace.match(/expenseDecisionChanged\(/g) ?? []).length >= 3,
    "the workspace must route the unsaved count, the save payload and the draft restore through " +
      "the shared predicate",
  );

  // The exact comparison the two call sites used to spell out by hand. If it comes back anywhere
  // in this file, the two have started drifting again and bug 1 is one term away.
  assert.doesNotMatch(
    workspace,
    /local\.hrApproved !== saved\.hrApproved/,
    "no hand-rolled copy of the decision comparison may live in the workspace",
  );

  // `changedReportIds` decides what is POSTED. Nothing else in the save path can rescue a report
  // that never enters this set, so this is the assertion that pins bug 1 shut.
  const changedReportIds = workspace.match(
    /const changedReportIds = new Set<string \| null>\(\);[\s\S]*?\n      \}/,
  )?.[0];
  assert.ok(changedReportIds, "save() must still build `changedReportIds` from the loaded records");
  assert.match(
    changedReportIds,
    /expenseDecisionChanged\(local, savedDecision\(record\)\)/,
    "the save payload must decide what to post with the same predicate the Save bar counts with",
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

  // ── 4. Unsaved work survives leaving the page ──────────────────────────────────────────────

  assert.match(
    workspace,
    /const draftKey = ownerScopedStorageKey\(EXPENSE_DECISION_DRAFT_KEY_BASE, viewerHrId\)/,
    "the queue must keep unsaved decisions somewhere a reload cannot clear — under the reviewer's own key",
  );
  assert.match(
    workspace,
    /writeExpenseDecisionDraft\(draftKey, decisions\)/,
    "and write that draft whenever the decisions change, not only on the way out",
  );
  assert.match(workspace, /readExpenseDecisionDraft\(draftKey\)/, "and read it back when the queue loads");

  // Registered only while something is unsaved: a permanently attached beforeunload makes the page
  // ineligible for the back/forward cache, which is why report-client-error.ts refuses to use one.
  const leaveGuard = workspace.match(
    /if \(dirtyCount === 0\) return;[\s\S]*?removeEventListener\("beforeunload", onBeforeUnload\);/,
  )?.[0];
  assert.ok(
    leaveGuard,
    "the leave warning must be gated on there being unsaved decisions, and must remove itself",
  );
}
