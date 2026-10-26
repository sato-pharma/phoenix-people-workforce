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

  for (const outcome of ["approved", "archived", "awaiting_next_stage", "closed", "in_flight", "rejected", "returned"] as const) {
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

  // Only the array literal itself: the helpers that sit below it (the "approved by you, waiting for
  // the next stage" rule) name pending_approval on purpose and are not part of this list.
  const statusesStart = service.indexOf("const MARKETING_HISTORY_STATUSES");
  const statuses = service.slice(statusesStart, service.indexOf("];", statusesStart));
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

  /* ---------------------------------------------------------------------- */
  /* 9. A long customer name WRAPS — it never truncates, scrolls, or escapes */
  /* ---------------------------------------------------------------------- */

  // Owner report, 2026-08-19: "the layout is broken on mobile". A real pharmacy name measured
  // 459px of text inside a 357px card on a 375px phone, so the card's content escaped its own box
  // and the whole PAGE scrolled sideways. That part is unchanged and still true.
  //
  // WHAT CHANGED, 2026-09-29: the first fix kept the heading `whitespace-nowrap` and put it in an
  // `overflow-x-auto` box, on the stated grounds that "two owner rules forbid the alternatives —
  // no ellipsis, and no wrapping onto a second line". Only the FIRST of those is a rule.
  // AGENTS.md §4 says the opposite of the second in as many words: "Never truncate text with an
  // ellipsis. Where it collides with the no-horizontal-scroll rule, WRAPPING WINS."
  //
  // And the measurement argues FOR wrapping rather than against it: a name needing 459px cannot
  // be READ in a 317px box whether it scrolls or not, and a sideways swipe on a heading is a
  // gesture nobody makes — so the old fix contained the overflow at the price of hiding half the
  // name behind an interaction no one performs. Measured after wrapping, with a 58-character real
  // name at 375px: two lines, 325px of 325px, nothing clipped, page overflow 0.
  //
  // Pinned on BOTH tabs: they sit on one page, and one tab wrapping while the other scrolls is
  // the inconsistency a reader notices first.
  for (const [label, text] of [["history", historyComponent], ["inbox", inbox]] as const) {
    assert.doesNotMatch(
      text,
      /<div className="overflow-x-auto">\s*<h3/,
      `${label}: the customer name must not go back inside an overflow-x box — it wraps now (AGENTS.md §4: wrapping wins)`,
    );
    assert.match(
      text,
      /<h3 className="mt-0\.5 text-phx-lg font-black tracking-tight text-slate-950">\s*\{row\.requestTitle\}/,
      `${label}: the request-title heading must carry no whitespace-nowrap, so a long name takes the second line it needs`,
    );
  }
  // And the banned escapes stay banned on the heading itself.
  //
  // POSITIVE CONTROL, and it is the point of this block rather than decoration. This pattern
  // shipped with both `\b` word boundaries eaten down to literal U+0008 BACKSPACE bytes, so it
  // could never match anything and `doesNotMatch` was a permanent green — the owner's no-ellipsis
  // rule was unguarded here from the day it was written. A negative assertion cannot be trusted
  // without proof that it can still see a real violation, so the two controls below fail loudly
  // the moment the pattern stops working. The trailing boundary is load-bearing: this file's own
  // `truncated` state variable must not be mistaken for the Tailwind `truncate` utility.
  const truncatedHeading = /<h3 className="[^"]*\btruncate\b/;
  assert.match(
    '<h3 className="mt-0.5 truncate text-phx-lg">Pharmacy</h3>',
    truncatedHeading,
    "the no-ellipsis pattern must match a heading that DOES truncate, or the assertion below is vacuous",
  );
  assert.doesNotMatch(
    '<h3 className="mt-0.5 truncated-marker">Pharmacy</h3>',
    truncatedHeading,
    "the no-ellipsis pattern must keep its word boundaries — `truncated` is not the `truncate` utility",
  );
  assert.doesNotMatch(
    historyComponent,
    truncatedHeading,
    "the customer name must never be truncated with an ellipsis — owner rule",
  );

  /* ---------------------------------------------------------------------- */
  /* 10. Desktop shows a TABLE, mobile shows cards - never cards everywhere  */
  /* ---------------------------------------------------------------------- */

  // Owner standing rule: the admin shell shows full tables on desktop and cards on mobile. The
  // History tab shipped as a stack of full-detail cards on EVERY screen (the exact violation)
  // until it was rebuilt to match the "In approval" tab beside it. The split must come from the
  // portal primitives, which carry a real `hidden ... md:block` / `md:hidden` pair. The
  // `data-portal-desktop-table` ATTRIBUTE alone is inert on an admin page (its media query is
  // injected by the portal shell, which admin pages never mount), so the primitives are the gate.
  assert.match(
    historyComponent,
    /PortalResponsiveDataList/,
    "the History tab must render through PortalResponsiveDataList - the md: split the owner rule needs",
  );
  assert.match(
    historyComponent,
    /PortalDesktopTable/,
    "the desktop view must be a real table, not cards - owner rule",
  );

  /* ---------------------------------------------------------------------- */
  /* 11. A long history is WINDOWED, never a wall of expanded trails         */
  /* ---------------------------------------------------------------------- */

  assert.match(
    historyComponent,
    /const HISTORY_PAGE_SIZE = \d+/,
    "the list must be windowed to a page size, not rendered all at once",
  );
  // Page clamped during RENDER, not from an effect - a filter that shortens the list must not
  // strand the reader on a page that no longer exists, and setState-in-effect is a lint error here.
  assert.match(
    historyComponent,
    /Math\.min\(page, pageCount - 1\)/,
    "the current page must be clamped during render so a shrinking list cannot strand the reader",
  );

  /* ---------------------------------------------------------------------- */
  /* 12. Accent classes are STATIC - never built by string interpolation    */
  /* ---------------------------------------------------------------------- */

  // Tailwind only ships classes it can see as whole literals. A `border-l-${tone}-500` is purged
  // from the bundle and paints nothing, so the outcome accent must come from a map of full class
  // strings. This one nearly shipped broken.
  assert.doesNotMatch(
    historyComponent,
    /border-l-\$\{/,
    "a Tailwind colour class must be a whole literal - an interpolated one is purged and paints nothing",
  );
}
