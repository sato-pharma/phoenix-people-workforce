import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The marketing approval inbox row card may only offer the decisions the STEP actually holds.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * `MarketingApproverInboxRow` has carried `allowReject` / `allowReturn` since the oversight queue
 * shipped — `buildRow` copies them straight off the step row, which is the only thing that knows
 * which powers a rung has. `InboxRowCard` ignored both and painted Approve, Return and Reject on
 * every row.
 *
 * Measured on PRODUCTION 2026-08-19: every Finance Execution step ever created carries
 * `allow_reject = false` — 6 of 6 — and MKT-REQ-20260814-6CD456E4 was sitting on that rung, current,
 * assigned to Finance Manager B-185 Ahmed El Maraghy, at the time of writing. The card was
 * therefore showing him a Reject button he cannot use.
 *
 * Traced, not assumed: `?decision=reject` only PRESELECTS the decision on the confirmation page —
 * it never auto-submits — and that page has gated its own Reject button on `summary.allowReject`
 * all along. So the click was a silent round trip to a page with the button missing, not an error.
 * The 400 sits below that: `decideMarketingRequestWorkflow` throws `marketing_reject_not_allowed`,
 * which is what proves the affordance dead rather than what the approver ever saw.
 *
 * The labels cannot stand in for the flags: that same step's `decision_labels` read
 * `{"approve":"Execute","return":"Return with a note","reject":"Reject"}` — a full reject label on a
 * step that may not reject. Only `allow_reject` knows.
 *
 * ── WHY IT IS ASSERTED OVER SOURCE TEXT ──────────────────────────────────────
 * `pnpm test` runs under `node --experimental-strip-types`, which strips types and does NOT compile
 * JSX, so no test in this suite can render a component. The regexes below are anchored to the
 * decision bar inside `InboxRowCard` specifically — not to the file — so an assertion cannot pass by
 * matching gating that lives somewhere else in the same module.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * An AFFORDANCE, never an authorisation. The decision page and the decision API both re-run the
 * full gate before anything is written, and §4 below pins that they still do. Hiding a control here
 * removes a dead end; it grants nothing to anybody.
 */
export function runMarketingInboxDecisionBarGatingTests() {
  const inbox = readFileSync("src/components/employee-portal/marketing-request-inbox.tsx", "utf8");

  /** One component's body, so no assertion can be satisfied by a sibling card in the same file. */
  const componentBody = (declaration: string): string => {
    const start = inbox.indexOf(declaration);
    assert.ok(start > -1, `expected to find ${declaration}`);
    const next = inbox.indexOf("\nfunction ", start + declaration.length);
    return inbox.slice(start, next > -1 ? next : inbox.length);
  };

  const card = componentBody("function InboxRowCard(");
  const barStart = card.indexOf('<div className="flex flex-wrap items-center gap-2 border-t');
  assert.ok(barStart > -1, "expected to find the decision bar inside InboxRowCard");
  const bar = card.slice(barStart);

  /* ---------------------------------------------------------------------- */
  /* 1. Approve always renders — a rung that cannot be advanced is not a rung */
  /* ---------------------------------------------------------------------- */

  const approveAt = bar.indexOf('decisionHref(decisionBasePath, row.id, "approve")');
  assert.ok(approveAt > -1, "the decision bar must still offer Approve");
  // Counted, not compared against the gate positions: `indexOf` returns -1 for a gate that is
  // MISSING, and a `> approveAt` comparison would then fail here instead of at §2 — this assertion
  // would report "Approve is gated" for the ungated-Reject bug it is not supposed to catch.
  // Verified by breaking it both ways: this fires only when a guard really does wrap Approve.
  const gatesBeforeApprove = bar.slice(0, approveAt).match(/\{row\.allow(Reject|Return) \? \(/g) ?? [];
  assert.deepEqual(
    gatesBeforeApprove,
    [],
    "Approve must render unconditionally — a rung that cannot be advanced is not a rung",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. THE HEADLINE. Return and Reject render only when the step allows them */
  /* ---------------------------------------------------------------------- */

  // Reject is the one that bites today: it is off on every Finance Execution step in production.
  assert.match(
    bar,
    /\{row\.allowReject \? \(\s*<Link[\s\S]*?decisionHref\(decisionBasePath, row\.id, "reject"\)[\s\S]*?<\/Link>\s*\) : null\}/,
    "the Reject link must be gated on row.allowReject — Finance Execution cannot reject, so an ungated button leads only to a page with no Reject on it",
  );
  assert.match(
    bar,
    /\{row\.allowReturn \? \(\s*<Link[\s\S]*?decisionHref\(decisionBasePath, row\.id, "return"\)[\s\S]*?<\/Link>\s*\) : null\}/,
    "the Return link must be gated on row.allowReturn — same rule, the other per-step power",
  );

  // And exactly one of each in the whole module, so the gated copy cannot be shadowed by an
  // ungated duplicate rendered elsewhere on the page.
  for (const decision of ["return", "reject"] as const) {
    const uses = inbox.match(new RegExp(`decisionHref\\(decisionBasePath, row\\.id, "${decision}"\\)`, "g")) ?? [];
    assert.equal(uses.length, 1, `${decision} must be linked from exactly one place, which is the gated one`);
  }

  /* ---------------------------------------------------------------------- */
  /* 3. The gate reads the FLAG, never the label                             */
  /* ---------------------------------------------------------------------- */

  // Production proof: the Finance Execution step that may not reject still carries
  // `decision_labels.reject = "Reject"`. A gate on the label would have rendered the button anyway.
  assert.doesNotMatch(
    bar,
    /\{row\.decisionLabels\.(reject|return)\s*(&&|\?)/,
    "presence of a label must never stand in for the power — a banned step still carries a full reject label",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. The UI gate is not the authorisation — the server still refuses      */
  /* ---------------------------------------------------------------------- */

  const service = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  assert.match(
    service,
    /if \(decision === "reject" && currentStep\.allowReject === false\)[\s\S]{0,220}marketing_reject_not_allowed/,
    "decideMarketingRequestWorkflow must still refuse a reject the step does not allow",
  );
  assert.match(
    service,
    /if \(decision === "return" && currentStep\.allowReturn === false\)[\s\S]{0,220}marketing_return_not_allowed/,
    "decideMarketingRequestWorkflow must still refuse a return the step does not allow",
  );

  // …and the flags must reach the row honestly, or the card would be gating on a constant.
  assert.match(
    service,
    /allowReject: step\.allowReject,\s*allowReturn: step\.allowReturn,/,
    "buildRow must copy both powers off the step row — the step is the only thing that knows them",
  );
  assert.match(
    service,
    /allowReject: row\.allow_reject \?\? true,\s*allowReturn: row\.allow_return \?\? true,/,
    "mapApprovalStep must default a NULL flag to true — an older step row predates the columns and holds both powers",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. The CC comment box is untouched                                      */
  /* ---------------------------------------------------------------------- */

  // AdvisoryRowCard is a non-blocking comment box for a CC reviewer. It has never offered a
  // decision and must not start now — gating it would read as though it once could.
  const advisory = componentBody("function AdvisoryRowCard(");
  assert.doesNotMatch(
    advisory,
    /decisionHref|row\.allowRe(ject|turn)/,
    "the CC advisory card decides nothing, so it must carry neither a decision link nor a decision gate",
  );

  /* ---------------------------------------------------------------------- */
  /* 6. Parity with the MM inbox, which already gates the same two powers    */
  /* ---------------------------------------------------------------------- */

  // Two inboxes over one chain. The day they disagree, whether an approver sees a dead Reject
  // button depends on which page they opened — which is the confusing half of this bug, twice.
  const mmInbox = readFileSync("src/components/employee-portal/dashboards/mm-inbox-client.tsx", "utf8");
  assert.match(mmInbox, /\{row\.allowReturn \? \(/, "the MM inbox must keep gating Return");
  assert.match(mmInbox, /\{row\.allowReject \? \(/, "the MM inbox must keep gating Reject");
}
