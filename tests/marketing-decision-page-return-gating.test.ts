import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The marketing decision confirmation page may only offer the decisions the STEP actually holds —
 * Return included, not only Reject.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * `allow_reject` and `allow_return` are a PAIR. They sit side by side on `marketing_workflow_steps`,
 * are snapshotted side by side onto every `marketing_request_approval_steps` row, and both
 * `MarketingWorkflowStep` and `MarketingRequestApprovalStep` have carried the pair in TypeScript
 * since the flags shipped. `MarketingRequestDecisionSummary` — the one object this page renders from
 * — carried only `allowReject`. `getMarketingRequestDecisionSummary` returned
 * `allowReject: currentStep.allowReject` and simply never returned the other half, even though the
 * same `currentStep` it was reading held it.
 *
 * So the page gated Reject correctly and painted Return unconditionally. Not because anyone decided
 * Return was ungatable, but because the flag never reached the component to gate on.
 *
 * ── WHY IT WAS LATENT, AND WHY THAT IS NOT A REASON TO LEAVE IT ──────────────
 * Measured on PRODUCTION 2026-08-19: `allow_return` is true on all 36 non-CC approval-step rows,
 * across all 5 step codes that exist (manager_chain 9, ceo_approval 7, marketing_review 7,
 * sfe_validation 7, finance_execution 6) — zero false, zero NULL — and true on all 8 rows of the
 * `marketing_workflow_steps` config table, the 3 inactive ones included. Nobody is looking at a dead
 * Return button today. The bug is that the day someone switches `allow_return` off on any rung — the
 * flag exists precisely so that it can be switched — this page would keep offering it, and the only
 * thing the approver would learn is a 400 from the API.
 *
 * `allow_reject` is what that switch looks like when it HAS been thrown: false on all 6
 * finance_execution rows. Finance Execution is a real rung, held by a real approver, that genuinely
 * may not reject. Return has simply not had its turn yet.
 *
 * ── WHY IT IS ASSERTED OVER SOURCE TEXT ──────────────────────────────────────
 * `pnpm test` runs under `node --experimental-strip-types`, which strips types and does NOT compile
 * JSX, so no test in this suite can render a component. The regexes below are anchored to the
 * decision bar inside `MarketingRequestDecisionConfirmation` specifically — not to the file — so an
 * assertion cannot pass by matching gating that lives somewhere else in the same module.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * An AFFORDANCE, never an authorisation. `decideMarketingRequestWorkflow` re-runs the full gate
 * before anything is written and throws `marketing_return_not_allowed`; §6 pins that it still does.
 * Hiding a control here removes a dead end; it grants nothing to anybody.
 *
 * Sibling: `marketing-inbox-decision-bar-gating.test.ts` pins the same two powers on the inbox row
 * card that LINKS to this page. Two surfaces, one chain — the day they disagree, whether an approver
 * sees a decision they cannot take depends on which one they opened.
 */
export function runMarketingDecisionPageReturnGatingTests() {
  const page = readFileSync("src/components/employee-portal/marketing-request-decision-confirmation.tsx", "utf8");
  const service = readFileSync("src/lib/marketing-requests/service.ts", "utf8");

  /** The confirmation component's body, so no assertion can be met by a helper elsewhere in the file. */
  const componentStart = page.indexOf("export function MarketingRequestDecisionConfirmation(");
  assert.ok(componentStart > -1, "expected to find MarketingRequestDecisionConfirmation");

  const barStart = page.indexOf('<div className="mt-4 flex flex-wrap gap-2">', componentStart);
  assert.ok(barStart > -1, "expected to find the decision bar inside MarketingRequestDecisionConfirmation");
  const barEnd = page.indexOf("{needsReason ?", barStart);
  assert.ok(barEnd > barStart, "expected the decision bar to end before the needsReason hint");
  const bar = page.slice(barStart, barEnd);

  /* ---------------------------------------------------------------------- */
  /* 1. Approve always renders — a rung that cannot be advanced is not a rung */
  /* ---------------------------------------------------------------------- */

  // `requestDecision`, not `submitDecision`: since the confirmation prompt shipped, a button OPENS
  // the "are you sure?" and only the prompt's own confirm button submits. What this file pins is
  // which buttons exist, so it follows the click to wherever the click now goes. That nothing may
  // still submit straight from an onClick is pinned separately, in
  // `marketing-decision-confirm-prompt.test.ts`.
  const approveAt = bar.indexOf('requestDecision("approve")');
  assert.ok(approveAt > -1, "the decision bar must still offer Approve");
  // Counted, not compared against the gate positions: `indexOf` returns -1 for a gate that is
  // MISSING, and a `> approveAt` comparison would then fail here instead of at §2 — this assertion
  // would report "Approve is gated" for the ungated-Return bug it is not supposed to catch.
  const gatesBeforeApprove = bar.slice(0, approveAt).match(/\{summary\.allow(Reject|Return) \? \(/g) ?? [];
  assert.deepEqual(
    gatesBeforeApprove,
    [],
    "Approve must render unconditionally — a rung that cannot be advanced is not a rung",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. THE HEADLINE. Return renders only when the step allows it            */
  /* ---------------------------------------------------------------------- */

  assert.match(
    bar,
    /\{summary\.allowReturn \? \(\s*<button[\s\S]*?requestDecision\("return"\)[\s\S]*?<\/button>\s*\) : null\}/,
    "the Return button must be gated on summary.allowReturn — a step with allow_return off can only answer the click with a 400",
  );
  // Reject has been gated all along. Pinned here so a later edit cannot "tidy" the pair back apart.
  assert.match(
    bar,
    /\{summary\.allowReject \? \(\s*<button[\s\S]*?requestDecision\("reject"\)[\s\S]*?<\/button>\s*\) : null\}/,
    "the Reject button must stay gated on summary.allowReject — same rule, the other per-step power",
  );

  // And exactly one of each in the whole module, so the gated copy cannot be shadowed by an ungated
  // duplicate rendered elsewhere on the page.
  for (const decision of ["return", "reject"] as const) {
    const uses = page.match(new RegExp(`requestDecision\\("${decision}"\\)`, "g")) ?? [];
    assert.equal(uses.length, 1, `${decision} must be offered from exactly one place, which is the gated one`);
  }

  /* ---------------------------------------------------------------------- */
  /* 3. The gate reads the FLAG, never the label                            */
  /* ---------------------------------------------------------------------- */

  // Production proof that a label cannot stand in for a power: the Finance Execution step that may
  // not reject still carries `decision_labels.reject = "Reject"`. Only `allow_reject` knows. The
  // bar reaches labels through `labelFor()` and must never branch on them.
  assert.doesNotMatch(
    bar,
    /summary\.decisionLabels/,
    "presence of a label must never stand in for the power — a banned step still carries a full label for it",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. The flag actually reaches the component                             */
  /* ---------------------------------------------------------------------- */

  // Gating on a field the summary does not carry is not a smaller bug than not gating at all — it
  // reads `undefined`, and Return disappears from EVERY rung, including the 36 in production that
  // hold the power. The type is what makes that unbuildable rather than merely untested.
  const summaryType = service.match(/export type MarketingRequestDecisionSummary = \{[\s\S]*?\n\};/);
  assert.ok(summaryType, "expected to find the MarketingRequestDecisionSummary type");
  assert.match(
    summaryType[0],
    /\ballowReturn: boolean;/,
    "MarketingRequestDecisionSummary must declare allowReturn — the component gates on it",
  );
  assert.match(
    summaryType[0],
    /\ballowReject: boolean;/,
    "MarketingRequestDecisionSummary must keep declaring allowReject — the two powers travel together",
  );
  assert.match(
    service,
    /allowReject: currentStep\.allowReject,\s*allowReturn: currentStep\.allowReturn,/,
    "getMarketingRequestDecisionSummary must copy BOTH powers off the current step — it is the only thing that knows them",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. A NULL flag on an old row still means "allowed"                     */
  /* ---------------------------------------------------------------------- */

  // An approval-step row created before the columns existed holds NULL, not false. Defaulting it to
  // false would strip Return from historic in-flight requests the moment this gate went live.
  assert.match(
    service,
    /allowReject: row\.allow_reject \?\? true,\s*allowReturn: row\.allow_return \?\? true,/,
    "mapApprovalStep must default a NULL flag to true — an older step row predates the columns and holds both powers",
  );

  /* ---------------------------------------------------------------------- */
  /* 6. The UI gate is not the authorisation — the server still refuses     */
  /* ---------------------------------------------------------------------- */

  assert.match(
    service,
    /if \(decision === "return" && currentStep\.allowReturn === false\)[\s\S]{0,220}marketing_return_not_allowed/,
    "decideMarketingRequestWorkflow must still refuse a return the step does not allow",
  );
  assert.match(
    service,
    /if \(decision === "reject" && currentStep\.allowReject === false\)[\s\S]{0,220}marketing_reject_not_allowed/,
    "decideMarketingRequestWorkflow must still refuse a reject the step does not allow",
  );
}
