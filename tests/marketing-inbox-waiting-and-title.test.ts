import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isApprovedByViewerAndWaiting,
  MARKETING_HISTORY_OUTCOME_LABEL,
  marketingAwaitingStageLabel,
  marketingWaitingStage,
} from "@/lib/marketing-requests/service";
import {
  marketingRequestActivity,
  marketingRequestTitle,
} from "@/lib/marketing-requests/request-title";
import type { MarketingRequestApprovalStep } from "@/lib/marketing-requests/types";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

function step(
  sequence: number,
  stepName: string,
  status: MarketingRequestApprovalStep["status"],
  hrId: string,
  overrides: Partial<MarketingRequestApprovalStep> = {},
): MarketingRequestApprovalStep {
  const decided = status === "approved";
  return {
    allowReject: true,
    allowReturn: true,
    assignedHrId: hrId,
    assignedRole: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    decisionAt: decided ? "2026-10-13T09:00:00.000Z" : null,
    decisionByHrId: decided ? hrId : null,
    decisionLabels: null,
    decisionNote: null,
    executedAt: null,
    id: `step-${sequence}`,
    isCc: false,
    requestId: "request-1",
    sequence,
    status,
    stepCode: `code-${sequence}`,
    stepKind: null,
    stepName,
    terminalStatus: null,
    updatedAt: "2026-10-13T09:00:00.000Z",
    workflowStepId: null,
    ...overrides,
  };
}

/**
 * The shape of the four live requests the owner's audit found on 2026-10-26: every rung from the
 * National Sales Manager (A-12) up to the CEO approved, and the Finance Execution rung (B-185)
 * holding the live turn. The request itself stays `pending_approval` until Finance answers.
 */
function financeStuckChain(): MarketingRequestApprovalStep[] {
  return [
    step(1, "National Sales Manager Approval", "approved", "A-12"),
    step(2, "SFE Validation", "approved", "A-2"),
    step(3, "Marketing Review", "approved", "A-8"),
    step(4, "CEO Approval", "approved", "AA"),
    step(5, "Finance Execution", "current", "B-185"),
  ];
}

const isNsm = (hrId: string | null | undefined) => hrId === "A-12";

/**
 * Two owner findings from the National Sales Manager's Marketing Inbox audit, 2026-10-26.
 *
 * 1. Four requests the NSM had approved, sitting at Finance, were on NEITHER tab. The pending tab
 *    lists rungs the viewer can still act on; the history tab lists requests that left
 *    `pending_approval`. A request past the viewer's rung but not yet final is in neither set.
 * 2. The card heading strung three names together (customer, type, requester). It is now the
 *    activity, then the requester.
 */
export async function runMarketingInboxWaitingAndTitleTests() {
  /* ---------------------------------------------------------------------- */
  /* 1. The hole: approved by the viewer, still with a later stage           */
  /* ---------------------------------------------------------------------- */

  const stuck = financeStuckChain();
  assert.equal(
    isApprovedByViewerAndWaiting({ chain: stuck, isActor: isNsm, requestStatus: "pending_approval" }),
    true,
    "a request the NSM approved that now sits at Finance must reach his history",
  );

  const waitingStage = marketingWaitingStage(stuck);
  assert.equal(waitingStage?.stepName, "Finance Execution", "the stage it waits on is the live rung");
  assert.equal(
    marketingAwaitingStageLabel(waitingStage?.stepName),
    "Approved by you · waiting for Finance Execution",
    "the label names the stage's real name",
  );
  // No stage name: a plain label, never "waiting for undefined".
  assert.equal(
    marketingAwaitingStageLabel(null),
    MARKETING_HISTORY_OUTCOME_LABEL.awaiting_next_stage,
  );
  assert.equal(marketingAwaitingStageLabel("   "), MARKETING_HISTORY_OUTCOME_LABEL.awaiting_next_stage);
  assert.doesNotMatch(marketingAwaitingStageLabel(null), /undefined|null|_/);

  // The label is never the word that means finished.
  assert.doesNotMatch(
    marketingAwaitingStageLabel("Finance Execution"),
    /^Approved$/,
    "a request still moving must not read as plainly Approved",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. What must NOT appear                                                  */
  /* ---------------------------------------------------------------------- */

  // Final already: the history tab's own status filter shows it, so it is not a waiting row.
  assert.equal(
    isApprovedByViewerAndWaiting({ chain: stuck, isActor: isNsm, requestStatus: "approved" }),
    false,
  );
  assert.equal(
    isApprovedByViewerAndWaiting({ chain: stuck, isActor: isNsm, requestStatus: "rejected" }),
    false,
  );

  // Somebody who did not approve a rung of it is not entitled to a "you approved" row.
  assert.equal(
    isApprovedByViewerAndWaiting({
      chain: stuck,
      isActor: (hrId) => hrId === "A-99",
      requestStatus: "pending_approval",
    }),
    false,
  );

  // He still holds an open rung: the pending tab already shows it, so listing it again would be two
  // rows for one request.
  const holdsOpenRung = [
    step(1, "National Sales Manager Approval", "approved", "A-12"),
    step(2, "Second Look", "current", "A-12"),
    step(3, "Finance Execution", "pending", "B-185"),
  ];
  assert.equal(
    isApprovedByViewerAndWaiting({ chain: holdsOpenRung, isActor: isNsm, requestStatus: "pending_approval" }),
    false,
  );

  // A rung he only approved as a CC reviewer is not an approval of the request.
  const ccOnly = [
    step(1, "Regional Manager Approval", "approved", "PD-0001"),
    step(2, "Comment from NSM", "approved", "A-12", { isCc: true }),
    step(3, "Finance Execution", "current", "B-185"),
  ];
  assert.equal(
    isApprovedByViewerAndWaiting({ chain: ccOnly, isActor: isNsm, requestStatus: "pending_approval" }),
    false,
  );

  // A CC reviewer is never what a request waits for.
  assert.equal(
    marketingWaitingStage([
      step(1, "Review Comment", "current", "A-8", { isCc: true }),
      step(2, "Finance Execution", "pending", "B-185"),
    ])?.stepName,
    "Finance Execution",
  );
  assert.equal(marketingWaitingStage([step(1, "CEO Approval", "approved", "AA")]), null);

  /* ---------------------------------------------------------------------- */
  /* 3. The service wires the rule in — and leaves the finished list alone   */
  /* ---------------------------------------------------------------------- */

  const service = source("src/lib/marketing-requests/service.ts");
  const start = service.indexOf("export async function getApproverDecidedRequests(");
  assert.ok(start > -1, "expected to find getApproverDecidedRequests");
  const history = service.slice(start, service.indexOf("\nexport ", start + 40) > -1 ? service.indexOf("\nexport ", start + 40) : undefined);

  assert.match(
    history,
    /\.eq\("status", "pending_approval"\)/,
    "the history read must load still-moving requests in a separate, narrowly filtered read",
  );
  // Loaded is not listed: the rows must also be merged into the list that is mapped and filtered.
  assert.match(
    history,
    /\[\.\.\.requestRows, \.\.\.waitingCandidateRows\]\.map\(mapRequest\)/,
    "the still-moving requests that were loaded must join the list the rows are built from",
  );
  assert.match(
    history,
    /isApprovedByViewerAndWaiting\(/,
    "a still-moving request may be listed only when the viewer approved a rung of it",
  );
  assert.match(history, /outcome: "awaiting_next_stage"|"awaiting_next_stage"/);
  assert.match(history, /allowReject: false/, "a waiting row must never carry a decision control");
  assert.match(history, /allowReturn: false/);

  // The finished-status list itself still excludes pending_approval (the history tab test pins the
  // same thing); the waiting rows are an addition beside it, not a loosening of it.
  const statusesStart = service.indexOf("const MARKETING_HISTORY_STATUSES");
  const statuses = service.slice(statusesStart, service.indexOf("];", statusesStart));
  assert.doesNotMatch(statuses, /"pending_approval"/);

  /* ---------------------------------------------------------------------- */
  /* 4. The title: the activity, then the requester                          */
  /* ---------------------------------------------------------------------- */

  // A request of the generic type carries the real activity as free text. Live requests, 2026-10-26.
  assert.equal(
    marketingRequestActivity("Other", "Work shop minia university pediatric department participating"),
    "Work shop minia university pediatric department participating",
  );
  assert.equal(
    marketingRequestTitle({
      activity: marketingRequestActivity("Other", "Work shop minia university pediatric department participating"),
      requesterName: "Mina Adel",
    }),
    "Work shop minia university pediatric department participating — Mina Adel",
  );
  // A named type with no free text: the type is the activity.
  assert.equal(marketingRequestActivity("Doctor Voucher", null), "Doctor Voucher");
  assert.equal(marketingRequestActivity("Doctor Voucher", "   "), "Doctor Voucher");
  // Stray whitespace collapses; nothing is invented when both are missing.
  assert.equal(marketingRequestActivity(null, "  Dinner   with  doctors "), "Dinner with doctors");
  assert.equal(marketingRequestActivity(null, null), "Marketing request");
  // No requester name: the title is the activity alone, never "X — null".
  assert.equal(marketingRequestTitle({ activity: "Doctor Voucher", requesterName: null }), "Doctor Voucher");
  assert.equal(marketingRequestTitle({ activity: "Doctor Voucher", requesterName: "  " }), "Doctor Voucher");
  // The title does not carry the customer — that moves to its own labelled line.
  assert.doesNotMatch(
    marketingRequestTitle({ activity: "Doctor Voucher", requesterName: "Mina Adel" }),
    /Pharmacy|·/,
  );

  /* ---------------------------------------------------------------------- */
  /* 5. Both tabs render it, and the service builds it from the helper       */
  /* ---------------------------------------------------------------------- */

  assert.equal(
    (service.match(/requestTitle: marketingRequestTitle\(/g) ?? []).length,
    2,
    "the pending row and the history row must both build the title through the shared helper",
  );
  for (const file of [
    "src/components/employee-portal/marketing-request-inbox.tsx",
    "src/components/employee-portal/marketing-request-history.tsx",
  ]) {
    const text = source(file);
    assert.match(text, /\{row\.requestTitle\}/, `${file}: the heading must show the request title`);
    assert.match(text, /Customer: \{row\.customerName\}/, `${file}: the customer sits on its own labelled line`);
    assert.doesNotMatch(
      text,
      /From \{row\.requesterName\} \(\{row\.requesterRole\}\)/,
      `${file}: the three-name subline must not come back`,
    );
  }

  // The History tab names the waiting stage, so a waiting row never reads as a plain outcome.
  const historyComponent = source("src/components/employee-portal/marketing-request-history.tsx");
  assert.match(historyComponent, /awaiting_next_stage/);
  assert.match(historyComponent, /Waiting for \$\{row\.waitingFor\.stepName\}/);
}
