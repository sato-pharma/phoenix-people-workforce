/**
 * The "are you sure?" a marketing approver sees before their decision commits.
 *
 * WHY THIS EXISTS. The decision page reviews the request at length and then commits on a single
 * click — `submitDecision` fired straight from the button's `onClick`, with nothing between the
 * pointer and an irreversible write. Approve releases company money; reject ends the request;
 * return sends it back down the chain. None of the three can be undone from the screen that did
 * it. The owner asked for the confirm step back on 19 Aug 2026, having valued it before.
 *
 * WHY A BUILDER AND NOT PROSE IN THE COMPONENT. The wording IS the safeguard — a prompt that says
 * "Are you sure?" and nothing else trains people to click through it. Each prompt has to name the
 * request, the money, and what specifically happens next, and that is worth pinning in a test
 * rather than leaving to whoever edits the JSX next.
 *
 * The confirm label deliberately repeats the step's OWN verb (Finance Execution says "Execute",
 * not "Approve"), so the last thing read before committing is the same word that was clicked.
 */

export type MarketingConfirmDecision = "approve" | "reject" | "return";

/**
 * What the decision page POSTs to `/api/marketing-requests/:id/decision`.
 *
 * WHY THIS IS A BUILDER. The page's note box is offered on every decision and its placeholder says
 * the note is "saved to audit history", but the request body was built inline as
 * `comment: decision === "approve" ? null : decisionComment` — so a note typed beside Approve (or
 * Finance Execution's "Execute", which is an approve) was thrown away in the browser and the step
 * was stamped with a NULL `decision_note`. Found 2026-10-18 on MKT-REQ-20261012-AA9F92DD, where the
 * Marketing Manager's note at Marketing Review never reached the database, the event log or the
 * CEO. The line dated from 2026-06-19, so every approve note typed on this page since was lost.
 *
 * The database stores whatever it is given (`NULLIF(btrim(p_decision_note), '')`), so the whole
 * defect lived in this one expression. Exported and pure so a test can run it instead of reading
 * source text. Return and reject still REQUIRE a note — that is checked before this is called.
 */
export function buildMarketingDecisionRequestBody(params: {
  comment?: string | null;
  decision: MarketingConfirmDecision;
}): { comment: string | null; decision: MarketingConfirmDecision } {
  const note = typeof params.comment === "string" ? params.comment.trim() : "";
  return { comment: note || null, decision: params.decision };
}

export type MarketingDecisionConfirmPrompt = {
  /** What is being decided — request, customer, money. */
  body: string;
  cancelLabel: string;
  /** The button that commits. Carries the step's own verb. */
  confirmLabel: string;
  /** What happens the moment they confirm. The part that makes the prompt worth reading. */
  consequence: string;
  title: string;
};

function egp(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `EGP ${Math.round(safe).toLocaleString("en-US")}`;
}

export function buildMarketingDecisionConfirmPrompt(params: {
  /** Where the request goes if this is approved — null when nothing is known to follow. */
  nextStepName?: string | null;
  customerName?: string | null;
  decision: MarketingConfirmDecision;
  /** The step's own word for this action, e.g. "Execute" on Finance Execution. */
  decisionLabel: string;
  estimatedCost: number;
  requestCode: string;
  requesterName: string;
}): MarketingDecisionConfirmPrompt {
  const label = params.decisionLabel.trim() || "Confirm";
  const forCustomer = params.customerName?.trim() ? ` for ${params.customerName.trim()}` : "";
  const body = `${params.requestCode}${forCustomer} — ${egp(params.estimatedCost)}, raised by ${params.requesterName}.`;

  if (params.decision === "approve") {
    const next = params.nextStepName?.trim();
    return {
      body,
      cancelLabel: "Go back",
      confirmLabel: `Yes, ${label.toLowerCase()}`,
      consequence: next
        ? `Approving passes it to ${next}. You cannot take this back from here.`
        : "Approving commits this spend. You cannot take this back from here.",
      title: `${label} this request?`,
    };
  }

  if (params.decision === "reject") {
    return {
      body,
      cancelLabel: "Go back",
      confirmLabel: `Yes, ${label.toLowerCase()}`,
      consequence:
        "Rejecting ends this request for good — every approval still waiting below is closed with it, and it cannot be reopened.",
      title: `${label} this request?`,
    };
  }

  return {
    body,
    cancelLabel: "Go back",
    confirmLabel: `Yes, ${label.toLowerCase()}`,
    consequence: `Returning sends it back to ${params.requesterName} to edit and resubmit. Approvals already given are kept.`,
    title: `${label} this request?`,
  };
}
