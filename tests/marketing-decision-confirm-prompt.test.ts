import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMarketingDecisionConfirmPrompt,
  buildMarketingDecisionRequestBody,
} from "../src/lib/marketing-requests/decision-confirm-prompt.ts";
import { stripComments } from "./support/comment-strip.ts";

const BASE = {
  customerName: "احمد وحيد",
  estimatedCost: 4000,
  requestCode: "MKT-REQ-20260818-8C628BF4",
  requesterName: "Nahed Elsayed",
};

export function runMarketingDecisionConfirmPromptTests() {
  // ── The prompt names the request, the money and the person ────────────────────────────────────
  // A prompt that only says "Are you sure?" trains the approver to click through it. What makes
  // this one worth reading is that it repeats the three facts the decision turns on.
  const approve = buildMarketingDecisionConfirmPrompt({
    ...BASE,
    decision: "approve",
    decisionLabel: "Approve",
    nextStepName: "Finance Execution",
  });
  assert.match(approve.body, /MKT-REQ-20260818-8C628BF4/, "the prompt must name the request being decided");
  assert.match(approve.body, /EGP 4,000/, "the prompt must state the money, formatted as the rest of the app does");
  assert.match(approve.body, /Nahed Elsayed/, "the prompt must name who raised it");
  assert.match(approve.body, /احمد وحيد/, "the customer travels through unchanged, Arabic included");

  // ── Each decision states its OWN consequence ──────────────────────────────────────────────────
  assert.match(
    approve.consequence,
    /Finance Execution/,
    "approving must name where the request goes next, not just say it was approved",
  );
  assert.match(approve.consequence, /cannot take this back/, "approve is irreversible from this screen and must say so");

  const approveAtEnd = buildMarketingDecisionConfirmPrompt({
    ...BASE,
    decision: "approve",
    decisionLabel: "Execute",
    nextStepName: null,
  });
  assert.doesNotMatch(
    approveAtEnd.consequence,
    /passes it to/,
    "with no rung after this one there is nobody to pass it to — the prompt must not invent a next approver",
  );
  assert.match(approveAtEnd.consequence, /commits this spend/, "the last rung still has to say what confirming does");

  const reject = buildMarketingDecisionConfirmPrompt({
    ...BASE,
    decision: "reject",
    decisionLabel: "Reject",
    nextStepName: "Finance Execution",
  });
  assert.match(
    reject.consequence,
    /cannot be reopened/,
    "reject ends the request for good — the one fact the approver most needs before confirming",
  );

  const returned = buildMarketingDecisionConfirmPrompt({
    ...BASE,
    decision: "return",
    decisionLabel: "Return for edit",
    nextStepName: "Finance Execution",
  });
  assert.match(returned.consequence, /Nahed Elsayed/, "return must name who receives it back");
  assert.match(
    returned.consequence,
    /Approvals already given are kept/,
    "return is not a reset — approvers who already signed must not be told their signature is lost",
  );

  // ── The confirm button repeats the step's own verb ────────────────────────────────────────────
  // Finance Execution calls it "Execute", not "Approve". The last word read before committing has
  // to be the same word that was clicked, or the prompt reads as being about a different action.
  assert.equal(approveAtEnd.confirmLabel, "Yes, execute", "the confirm button carries the step's own verb");
  assert.equal(approveAtEnd.title, "Execute this request?", "so does the title");
  assert.equal(reject.confirmLabel, "Yes, reject");
  assert.equal(approve.cancelLabel, "Go back", "cancelling must read as a way out, never as a second decision");

  // A step with no label of its own still gets a usable button rather than an empty one.
  const unlabelled = buildMarketingDecisionConfirmPrompt({
    ...BASE,
    decision: "approve",
    decisionLabel: "   ",
    nextStepName: null,
  });
  assert.equal(unlabelled.confirmLabel, "Yes, confirm", "a blank step label must not produce a blank confirm button");

  // A missing customer must not leave a dangling "for " in the sentence.
  const noCustomer = buildMarketingDecisionConfirmPrompt({
    ...BASE,
    customerName: null,
    decision: "approve",
    decisionLabel: "Approve",
    nextStepName: null,
  });
  assert.doesNotMatch(noCustomer.body, /\sfor\s+—/, "an absent customer drops the clause instead of rendering an empty one");

  // ── Both decision surfaces actually go through the prompt ─────────────────────────────────────
  // The builder is only a safeguard if nothing can still commit on a bare click. There are exactly
  // two places a marketing decision is sent from, and both must ask first.
  const decisionPage = readFileSync(
    new URL("../src/components/employee-portal/marketing-request-decision-confirmation.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    decisionPage,
    /buildMarketingDecisionConfirmPrompt/,
    "the decision page must build its prompt from the shared builder, not from prose in the JSX",
  );
  for (const decision of ["approve", "return", "reject"]) {
    assert.match(
      decisionPage,
      new RegExp(`onClick=\\{\\(\\) => requestDecision\\("${decision}"\\)\\}`),
      `${decision} must open the confirmation, not submit`,
    );
  }
  assert.doesNotMatch(
    decisionPage,
    /onClick=\{\(\) => void submitDecision\(/,
    "no decision button may call submitDecision straight from its onClick — that is the unguarded click this exists to remove",
  );

  const actionCenter = readFileSync(
    new URL("../src/components/action-center/action-center-hub.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    actionCenter,
    /buildMarketingDecisionConfirmPrompt/,
    "the Action Center is the CEO's other route to the same write and must ask with the same words",
  );
  const handler = actionCenter.slice(
    actionCenter.indexOf("function handleMarketingAction("),
    actionCenter.indexOf("function confirmMarketingAction("),
  );
  assert.ok(handler.length > 0, "handleMarketingAction and confirmMarketingAction must both exist, in that order");
  assert.doesNotMatch(
    handler,
    /callApi\(/,
    "clicking a marketing button in the Action Center must not reach the API — only the confirmation may",
  );

  // ── A note typed beside ANY decision reaches the database ─────────────────────────────────────
  // MKT-REQ-20261012-AA9F92DD, 2026-10-18: the Marketing Manager typed a note on this page and
  // approved; the step was stamped with a NULL decision_note, the event log held `note: null`, and
  // the CEO never saw it. The page built its body as `decision === "approve" ? null : note`, so every
  // approve note since 2026-06-19 — Finance Execution's "Execute" included — died in the browser
  // while the box's own placeholder promised it was "saved to audit history".
  const approveWithNote = buildMarketingDecisionRequestBody({
    comment: "  Approved for the ENT and IM doctors only.  ",
    decision: "approve",
  });
  assert.deepEqual(
    approveWithNote,
    { comment: "Approved for the ENT and IM doctors only.", decision: "approve" },
    "an approve with a note must send that note, trimmed — it is the whole defect",
  );
  for (const decision of ["approve", "return", "reject"] as const) {
    assert.equal(
      buildMarketingDecisionRequestBody({ comment: "the reason", decision }).comment,
      "the reason",
      `${decision} must carry its note to the API`,
    );
    // Approve needs no note: a blank box is a null, never an empty string the RPC would have to clean.
    for (const blank of ["", "   \n ", null, undefined]) {
      assert.equal(
        buildMarketingDecisionRequestBody({ comment: blank, decision }).comment,
        null,
        `${decision} with a blank note sends null`,
      );
    }
    assert.equal(buildMarketingDecisionRequestBody({ comment: "x", decision }).decision, decision);
  }
  // The page posts through the builder. Comments are stripped first because the builder's own
  // explanation quotes the old expression, and a "must not appear" guard would trip on its own prose.
  const pageCode = stripComments(decisionPage);
  assert.match(
    pageCode,
    /JSON\.stringify\(buildMarketingDecisionRequestBody\(\{ comment: decisionComment, decision \}\)\)/,
    "the decision page must build its request body with buildMarketingDecisionRequestBody",
  );
  assert.doesNotMatch(
    pageCode,
    /decision === "approve" \? null/,
    "no decision may be special-cased to drop the note — an approve note is a record somebody will read",
  );
}
