import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { buildCaseFileDecisionBar, type DecisionBarStep } from "@/lib/marketing-requests/case-file-decision-bar";

// ─────────────────────────────────────────────────────────────────────────────
// The Case File must let its own approver ANSWER, not just read.
//
// Every marketing notification ever sent stores `/marketing-requests/<id>` as its actionUrl, and
// since #2079 that URL renders the Case File. Before #2079 it redirected into the approval inbox,
// where the Approve / Return / Reject buttons live — so the change that finally made the link land
// on the request removed the recipient's only one-click route to act on it.
//
// Found live on 2026-08-19: MKT-REQ-20260818-8C628BF4 (EGP 3,000) opened `ceo_approval` at 15:53
// Cairo, the CEO was notified on in-app, email and push within the second, every one of those
// links opened this page, and none of them offered him a decision. His Telegram — the ONLY channel
// carrying one-tap buttons — is not connected, so he had no route at all. `viewer.can.decide` had
// been computed correctly on the payload the whole time; nothing rendered it.
//
// The four assertions below pin the four ways that reopens: the bar disappearing, the hrefs going
// shell-wrong, a rung being offered a power it does not have, and the component dropping it again.
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** A CEO Approval rung: all three powers, the workflow's own wording. */
const ceoStep: DecisionBarStep = {
  allowReject: true,
  allowReturn: true,
  decisionLabels: { approve: "Approve", reject: "Reject", return: "Return" },
  stepName: "CEO Approval",
};

const REQUEST_ID = "460cb020-55c1-4fbc-ad70-2a5ca95c1600";

export function runMarketingCaseFileDecisionBarTests() {
  /* ---------------------------------------------------------------------- */
  /* The headline: the holder of the open rung gets controls                 */
  /* ---------------------------------------------------------------------- */

  const ceoBar = buildCaseFileDecisionBar({
    canDecide: true,
    navigationMode: "admin",
    requestId: REQUEST_ID,
    step: ceoStep,
  });
  assert.notEqual(
    ceoBar,
    null,
    "the holder of the current gating rung must get a decision bar — a notification that lands on a page with no answer on it is the whole defect",
  );
  assert.equal(
    ceoBar?.stepName,
    "CEO Approval",
    "the bar names the rung, so 'approve' is never an unlabelled yes on a chain with four of them",
  );
  assert.deepEqual(
    ceoBar?.actions.map((action) => action.decision),
    ["approve", "return", "reject"],
    "approve leads; return and reject follow in the same order the approval inbox uses",
  );

  /* ---------------------------------------------------------------------- */
  /* It is an affordance, so it must vanish for everyone else                */
  /* ---------------------------------------------------------------------- */

  assert.equal(
    buildCaseFileDecisionBar({ canDecide: false, navigationMode: "admin", requestId: REQUEST_ID, step: ceoStep }),
    null,
    "a viewer who cannot decide must see NO control — Super Admin oversight and 'coming to you' are watch lists, not queues",
  );
  assert.equal(
    buildCaseFileDecisionBar({ canDecide: true, navigationMode: "admin", requestId: REQUEST_ID, step: null }),
    null,
    "no open gating rung means nothing to answer — a finished request must never render a live Approve",
  );

  /* ---------------------------------------------------------------------- */
  /* Shell-correct hrefs: the Case File URL is shared by BOTH shells         */
  /* ---------------------------------------------------------------------- */

  // One stored actionUrl serves the whole chain, which mixes admin-shell roles (CEO, SFE Manager,
  // Finance Manager) with portal roles (District Manager). A hardcoded path is wrong for half of
  // them: the portal page redirects admin-shell approvers to /overview and the workspace page
  // redirects portal roles straight back out.
  const adminApprove = ceoBar?.actions.find((action) => action.decision === "approve");
  assert.equal(
    adminApprove?.href,
    `/workspace/marketing-requests/decision/${REQUEST_ID}?decision=approve`,
    "an admin-shell approver must be sent to the WORKSPACE decision page",
  );

  const portalBar = buildCaseFileDecisionBar({
    canDecide: true,
    navigationMode: "employee-portal",
    requestId: REQUEST_ID,
    step: ceoStep,
  });
  assert.equal(
    portalBar?.actions.find((action) => action.decision === "approve")?.href,
    `/employee-portals/marketing-requests/decision/${REQUEST_ID}?decision=approve`,
    "a portal approver must be sent to the PORTAL decision page — the same bar, resolved per viewer",
  );

  /* ---------------------------------------------------------------------- */
  /* A rung is only offered the powers it actually has                       */
  /* ---------------------------------------------------------------------- */

  // Finance Execution carries allow_reject = false and its own wording ("Execute", "Return with a
  // note"). Rendering a Reject there is a control whose only possible outcome is a 400 —
  // decideMarketingRequestWorkflow throws `marketing_reject_not_allowed` for exactly this.
  const financeBar = buildCaseFileDecisionBar({
    canDecide: true,
    navigationMode: "admin",
    requestId: REQUEST_ID,
    step: {
      allowReject: false,
      allowReturn: true,
      decisionLabels: { approve: "Execute", reject: "Reject", return: "Return with a note" },
      stepName: "Finance Execution",
    },
  });
  assert.deepEqual(
    financeBar?.actions.map((action) => action.decision),
    ["approve", "return"],
    "a rung that may not reject must not be handed a Reject button the API will refuse",
  );
  assert.deepEqual(
    financeBar?.actions.map((action) => action.label),
    ["Execute", "Return with a note"],
    "the STEP's own wording wins — the owner's rule is human language, never a generic verb the workflow has renamed",
  );

  // A step with no configured labels still gets pressable controls rather than blank ones.
  const unlabelled = buildCaseFileDecisionBar({
    canDecide: true,
    navigationMode: "admin",
    requestId: REQUEST_ID,
    step: { allowReject: true, allowReturn: true, decisionLabels: null, stepName: "Marketing Review" },
  });
  assert.deepEqual(
    unlabelled?.actions.map((action) => action.label),
    ["Approve", "Return", "Reject"],
    "a rung with no decision_labels row falls back to the three plain verbs, never to an empty button",
  );

  /* ---------------------------------------------------------------------- */
  /* And the view must actually RENDER it                                    */
  /* ---------------------------------------------------------------------- */

  // The capability existed and was ignored for three weeks. Computing it again and not rendering it
  // reproduces the outage exactly, so the JSX usage is pinned, not the import.
  const viewSource = source("src/components/marketing-requests/marketing-request-case-file.tsx");
  assert.match(
    viewSource,
    /viewer\.decision \? <DecisionBar decision=\{viewer\.decision\}/,
    "the Case File view must RENDER viewer.decision — an unrendered capability is the defect this test exists for",
  );

  const serviceSource = source("src/lib/marketing-requests/case-file-service.ts");
  assert.match(
    serviceSource,
    /decision: buildCaseFileDecisionBar\(\{/,
    "the case file payload must carry the decision bar, or the view has nothing to render",
  );
  assert.match(
    serviceSource,
    /navigationMode: resolveNavigationMode\(access\)/,
    "the bar's hrefs must be resolved from the VIEWER's shell — the Case File URL is shared by both",
  );

  // Nothing on a Marketing requests screen is drawn below 11px ("raise the marketing requests screens' fonts too",
  // owner, 2026-11-09). Every .tsx under src/components/marketing-requests is read, so a new screen is held to it as well.
  let marketingScreens = 0;
  for (const entry of readdirSync("src/components/marketing-requests", { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".tsx")) continue;
    const file = `src/components/marketing-requests/${entry.replace(/\\/g, "/")}`;
    marketingScreens++;
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b|text-\[(?:[1-9]|10)px\]/.test(readFileSync(file, "utf8")), `${file}: no text below 11px on a Marketing requests screen`);
  }
  assert.ok(marketingScreens >= 30, `the floor read every Marketing requests screen (${marketingScreens})`);
}
