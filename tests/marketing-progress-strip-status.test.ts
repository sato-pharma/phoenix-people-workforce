import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The tracking strip stops claiming somebody is holding a request that ended.
//
// MarketingRequestStepProgress carries no status — approvedGatingCount, currentApproverHrId,
// currentApproverName, currentStepName, returnReason, sequence, totalGatingSteps and nothing else.
// So the strip printed "Step 1/5 · Currently with: Finance Execution" for EVERY request it was
// handed, including refused ones, where it names a rung Finance never saw and asserts that a named
// colleague still owes a decision on a request that died weeks ago.
//
// This is the surface the audit called the module's headline failure. The fix is not cosmetic: the
// component cannot tell the truth without the status, so the status is now a required prop.
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** One component's body, so an assertion cannot pass by matching a sibling component. */
function componentBody(text: string, declaration: string) {
  const start = text.indexOf(declaration);
  assert.ok(start > -1, `expected to find ${declaration}`);
  const next = text.indexOf("\nexport function ", start + declaration.length);
  return text.slice(start, next > -1 ? next : text.length);
}

export async function runMarketingProgressStripStatusTests() {
  const strip = source("src/components/employee-portal/marketing-approval-timeline.tsx");
  const body = componentBody(strip, "export function MarketingProgressStrip(");

  /* ---------------------------------------------------------------------- */
  /* 1. The status is REQUIRED — a caller cannot fall back to the old lie    */
  /* ---------------------------------------------------------------------- */

  assert.match(
    body,
    /status: MarketingRequestStatus;/,
    "status must be a required prop — optional would let a caller silently keep the old behaviour",
  );
  assert.ok(
    !/status\?: MarketingRequestStatus/.test(body),
    "status must not be optional: the component cannot tell the truth without it",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. "Currently with" is gated on the request actually being in flight    */
  /* ---------------------------------------------------------------------- */

  assert.match(
    body,
    /const inFlight = status === "pending_approval";/,
    "only a request still in approval has someone holding it",
  );
  const currentlyWithAt = body.indexOf("Currently with:");
  const gateAt = body.indexOf("{inFlight ? (");
  assert.ok(currentlyWithAt > -1, 'expected the "Currently with" line to still exist for live requests');
  assert.ok(
    gateAt > -1 && gateAt < currentlyWithAt,
    '"Currently with" must sit inside the inFlight branch — unconditionally, it is the defect itself',
  );

  // The approver's NAME is the part that makes the sentence a false accusation, so it must be
  // inside the same branch rather than trailing outside it.
  const currentApproverAt = body.indexOf("{currentApprover}");
  const elseAt = body.indexOf(") : (", gateAt);
  assert.ok(
    currentApproverAt > -1 && elseAt > -1 && currentApproverAt < elseAt,
    "the named approver must be inside the in-flight branch, not rendered for finished requests",
  );

  /* ---------------------------------------------------------------------- */
  /* 3. A finished request says what happened instead                        */
  /* ---------------------------------------------------------------------- */

  assert.match(
    body,
    /\{terminalSentence\(status\)\}/,
    "a request no longer in approval must state its outcome, not a rung",
  );

  const sentences = componentBody(strip, "function terminalSentence(");
  assert.match(
    sentences,
    /case "rejected":\s*\n\s*return "Refused[^"]*nobody is waiting[^"]*";/,
    "a refused request must say plainly that nobody is waiting on it",
  );
  assert.match(
    sentences,
    /case "returned":/,
    "a returned request must say it is back with its requester",
  );
  assert.match(
    sentences,
    /case "approved":/,
    "an approved request must say no approvals are outstanding",
  );
  assert.ok(
    !/Currently with/.test(sentences),
    'no terminal outcome may read as "currently with" — that is the sentence being removed',
  );
  // An unmapped status must still produce a sentence rather than falling through to nothing.
  assert.match(
    sentences,
    /default:\s*\n\s*return `No longer in approval \(\$\{status\.replace\(\/_\/g, " "\)\}\)`;/,
    "an unmapped status must still say something readable, with the database underscores removed",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. Tracking is no longer the end of the road                            */
  /* ---------------------------------------------------------------------- */

  assert.match(
    body,
    /href=\{`\/marketing-requests\/\$\{requestId\}`\}/,
    "the strip must offer the full record — the case file is the one place the whole request exists",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. The caller actually passes it                                        */
  /* ---------------------------------------------------------------------- */

  const drafts = source("src/components/employee-portal/marketing-request-drafts.tsx");
  assert.match(
    drafts,
    /<MarketingProgressStrip\s*\n\s*progress=\{progress\}\s*\n\s*requestId=\{request\.id\}\s*\n\s*status=\{request\.status\}\s*\n?\s*\/>/,
    "the tracking list must hand the strip the request's real status and id",
  );
}
