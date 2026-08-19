import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MARKETING_HISTORY_OUTCOME_LABEL,
  marketingHistoryOutcome,
} from "@/lib/marketing-requests/service";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/** The body of one function, so an assertion cannot pass by matching unrelated code elsewhere. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start > -1, `expected to find ${declaration}`);
  const nextExport = text.indexOf("\nexport async function ", start + declaration.length);
  const nextPlain = text.indexOf("\nexport function ", start + declaration.length);
  const ends = [nextExport, nextPlain].filter((index) => index > -1);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

/**
 * The History tab of the marketing approval inbox.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * Owner instruction, 2026-08-19. The inbox showed live work only: awaiting my decision, coming to
 * me, awaiting my comment, and (Super Admin) everything in approval. All four sections query steps
 * that are still open, so a request DISAPPEARED from that page the moment it was answered. "What
 * did we decide on this pharmacy, and why" therefore had no answer anywhere near the screen where
 * the decision was actually made.
 *
 * ── THE LIMITS, WHICH MATTER MORE THAN THE FEATURE ───────────────────────────
 * A history view is a read of decisions other people made, so the two things that can go wrong are
 * (1) showing somebody a request they were never entitled to see and (2) letting a finished request
 * render a decision control. Both are pinned below.
 *
 * The scope gate is deliberately the SAME one as the live oversight section
 * (`canViewMarketingOversightQueue`, Super Admin / system scope). Reusing it means the History tab
 * exposes nothing to anyone who could not already watch the live queue — a second, looser gate
 * would have widened marketing visibility without anybody deciding to.
 */
export async function runMarketingApprovalHistoryTabTests() {
  /* ---------------------------------------------------------------------- */
  /* 1. Outcome mapping — approved-and-onward folds, pre-decision does NOT   */
  /* ---------------------------------------------------------------------- */

  // Everything past a yes reads as "Approved". A request can only reach these by being approved,
  // so folding them loses no truth — and the raw status stays on the row for anyone who needs it.
  assert.equal(marketingHistoryOutcome("approved"), "approved");
  assert.equal(marketingHistoryOutcome("active"), "approved");
  assert.equal(marketingHistoryOutcome("roi_tracking"), "approved");
  assert.equal(marketingHistoryOutcome("finance_hold"), "approved");

  assert.equal(marketingHistoryOutcome("rejected"), "rejected");
  assert.equal(marketingHistoryOutcome("returned"), "returned");
  assert.equal(marketingHistoryOutcome("closed"), "closed");
  assert.equal(marketingHistoryOutcome("archived"), "archived");

  // THE HEADLINE. A request that has NOT been decided must never be labelled as though it had.
  // The query excludes these rows, so this branch is reachable only if the lifecycle grows a new
  // pre-decision status — at which point "Still in approval" is the harmless answer and "Approved"
  // is the one that would have somebody paying against a request nobody signed.
  assert.equal(marketingHistoryOutcome("pending_approval"), "in_flight");
  assert.equal(marketingHistoryOutcome("draft"), "in_flight");
  assert.equal(marketingHistoryOutcome("pending_validation"), "in_flight");

  /* ---------------------------------------------------------------------- */
  /* 2. Every outcome carries a human label — never a raw code (owner rule)  */
  /* ---------------------------------------------------------------------- */

  for (const outcome of ["approved", "archived", "closed", "in_flight", "rejected", "returned"] as const) {
    const label = MARKETING_HISTORY_OUTCOME_LABEL[outcome];
    assert.ok(label && label.length > 0, `${outcome} must have a label`);
    // A label that is just the key echoed back is a raw code with extra steps.
    assert.notEqual(label, outcome);
    assert.doesNotMatch(label, /_/, `${outcome} label must read as English, not as a code`);
  }
  assert.equal(MARKETING_HISTORY_OUTCOME_LABEL.in_flight, "Still in approval");

  const service = source("src/lib/marketing-requests/service.ts");
  const history = functionBody(service, "export async function getApproverDecidedRequests(");

  /* ---------------------------------------------------------------------- */
  /* 3. Scope: the SAME gate as the live oversight queue, and nothing wider  */
  /* ---------------------------------------------------------------------- */

  assert.match(
    history,
    /const includeOversight = canViewMarketingOversightQueue\(access\)/,
    "the company-wide branch must reuse canViewMarketingOversightQueue — a second gate would widen visibility silently",
  );
  // Everyone else is scoped to their OWN rungs. Both columns, because a re-assigned step is decided
  // by somebody who is no longer its assignee and an approver keeps the record of their own call.
  assert.match(history, /\.in\("assigned_hr_id", actorHrKeys\)/, "non-oversight viewers must be scoped by assigned_hr_id");
  assert.match(history, /\.in\("decision_by_hr_id", actorHrKeys\)/, "non-oversight viewers must also match steps they decided");
  // And their OWN requests (owner instruction, 2026-08-19). A requester who never sat on the chain
  // holds no rung, so the two step queries above return nothing for them — the person with the most
  // reason to ask "what was decided" was the one person getting an empty page. Not a widening:
  // getMarketingRequestDetail already serves a requester their own request in full.
  assert.match(
    history,
    /\.in\("requester_hr_id", actorHrKeys\)/,
    "a viewer must also see the requests they RAISED, not only the rungs they held",
  );
  // hrIdLookupKeys, not the raw session id: assigned_hr_id is stored in the employee master's real
  // casing while the session id is lower-cased, and a casing miss reads as an empty history.
  assert.match(history, /hrIdLookupKeys\(actorHrId\)/, "HR_ID matching must go through hrIdLookupKeys");

  /* ---------------------------------------------------------------------- */
  /* 4. A finished request can never render a decision control              */
  /* ---------------------------------------------------------------------- */

  // A requester looking at their own request is NOT oversight. If viaOversight stayed
  // `myStep === null` the card would tell every requester they are seeing it "because you can see
  // the whole company queue" — which is both wrong and a claim about their permissions.
  assert.match(
    history,
    /viaOversight: myStep === null && !isMyRequest/,
    "raising a request must not be reported to the requester as company-wide oversight",
  );
  assert.match(history, /const isMyRequest = isActor\(request\.requesterHrId\)/, "the row must know whether the viewer raised it");

  assert.match(history, /allowReject: false/, "history rows must force allowReject false");
  assert.match(history, /allowReturn: false/, "history rows must force allowReturn false");

  // And the tab itself must not link into the decision screen at all.
  const historyComponent = source("src/components/employee-portal/marketing-request-history.tsx");
  assert.doesNotMatch(
    historyComponent,
    /decision=(approve|reject|return)|decisionBasePath/,
    "the History tab must not build a decision link — the request has already been answered",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. Only requests that have LEFT the chain appear                        */
  /* ---------------------------------------------------------------------- */

  const statuses = service.slice(
    service.indexOf("const MARKETING_HISTORY_STATUSES"),
    service.indexOf("const MARKETING_HISTORY_ROW_LIMIT"),
  );
  assert.ok(statuses.length > 0, "expected to find MARKETING_HISTORY_STATUSES");
  for (const live of ["pending_approval", "pending_validation", "draft"]) {
    assert.doesNotMatch(
      statuses,
      new RegExp(`"${live}"`),
      `${live} must never be in the history status list — it is still somebody's open work`,
    );
  }
  for (const finished of ["approved", "rejected", "returned", "closed", "archived"]) {
    assert.match(statuses, new RegExp(`"${finished}"`), `${finished} must be in the history status list`);
  }
  // EVERY read filters on it, not just the candidate lookup — the oversight branch orders by
  // updated_at, the requester branch selects by requester_hr_id, and the per-id load re-checks, so a
  // request that re-enters the chain drops out of all three.
  assert.equal(
    (history.match(/\.in\("status", \[\.\.\.MARKETING_HISTORY_STATUSES\]\)/g) ?? []).length,
    3,
    "the oversight candidates, the requester candidates and the request load must each filter on the finished statuses",
  );

  /* ---------------------------------------------------------------------- */
  /* 6. The cap is stated, never silent                                      */
  /* ---------------------------------------------------------------------- */

  assert.match(history, /truncated/, "the read must report whether it hit its ceiling");
  assert.match(
    historyComponent,
    /Showing the most recently decided requests only/,
    "the UI must SAY when it is showing a partial history rather than presenting it as the whole record",
  );

  /* ---------------------------------------------------------------------- */
  /* 7. The route owns no gate of its own                                    */
  /* ---------------------------------------------------------------------- */

  const route = source("app/api/marketing-requests/inbox/history/route.ts");
  assert.match(route, /resolveAccessContext\(request\)/, "the route must resolve the real access context");
  assert.match(route, /getApproverDecidedRequests\(access\)/, "the route must delegate to the service");
  assert.match(route, /isForbiddenError\(error\)/, "a forbidden error must map to 403, not to a 500");

  /* ---------------------------------------------------------------------- */
  /* 8. The two tabs share ONE chain renderer                                */
  /* ---------------------------------------------------------------------- */

  // Two copies drift, and the day they disagree is the day somebody reads a past approval wrong.
  const inbox = source("src/components/employee-portal/marketing-request-inbox.tsx");
  assert.match(inbox, /from "@\/components\/employee-portal\/marketing-approval-chain"/);
  assert.match(historyComponent, /from "@\/components\/employee-portal\/marketing-approval-chain"/);
  assert.doesNotMatch(
    inbox,
    /^function ApprovalHistory\(/m,
    "ApprovalHistory must live in the shared module, not be re-declared per tab",
  );
}
