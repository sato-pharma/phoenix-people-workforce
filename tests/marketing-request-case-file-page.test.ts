import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveMarketingRequestDestination } from "@/lib/marketing-requests/notification-link";
import { parseMarketingRequestDecision } from "@/lib/marketing-requests/service";

// ─────────────────────────────────────────────────────────────────────────────
// /marketing-requests/[requestId] must RENDER the request, not redirect to a list.
//
// Every marketing notification ever sent stores `actionUrl = /marketing-requests/<id>`
// (marketingRequestNotificationUrl). That route owned no UI — it redirected to the inbox LIST,
// carrying `?request=<id>` that no page has ever read. Measured on production 2026-08-12:
//
//   GET /marketing-requests/<id>  ->  307  /employee-portals/marketing-requests/inbox?request=<id>
//
// So "Marketing request needs your approval" meant "go and find it yourself". Rendering the request
// at that URL repairs every historical link with no data migration.
//
// The `?decision=` one-tap path is deliberately UNCHANGED and is pinned here too, because the
// obvious way to break it is to start rendering unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export async function runMarketingRequestCaseFilePageTests() {
  const pageSource = source("app/marketing-requests/[requestId]/page.tsx");
  const viewSource = source("src/components/marketing-requests/marketing-request-case-file.tsx");

  /* ---------------------------------------------------------------------- */
  /* The headline: the route renders the request                            */
  /* ---------------------------------------------------------------------- */

  assert.match(
    pageSource,
    /getMarketingRequestCaseFile\(/,
    "the marketing request route must READ the request and render it — every notification actionUrl points at this URL, and for a long time there was nothing at the end of it",
  );
  // The JSX usage, not the import line — asserting the bare name passes even if the component is
  // imported and then never rendered.
  assert.match(
    pageSource,
    /<MarketingRequestCaseFileView\s/,
    "the route must RENDER the case file view, not merely import it",
  );

  /* ---------------------------------------------------------------------- */
  /* The one-tap decision path is untouched                                  */
  /* ---------------------------------------------------------------------- */

  // Same parser the decision page uses, so the two cannot drift apart.
  assert.match(
    pageSource,
    /parseMarketingRequestDecision\(/,
    "the decision redirect must reuse the canonical parser, never a second inline copy",
  );
  for (const decision of ["approve", "reject", "return"] as const) {
    assert.equal(
      parseMarketingRequestDecision(decision),
      decision,
      `${decision} must remain a real decision, or the Telegram one-tap button silently becomes a read-only page open`,
    );
    // Both shells: the approver chain spans admin (Super Admin, SFE Manager, Marketing Manager)
    // and portal (National Sales Manager, District Manager), and each shell's guard redirects the
    // other's users away — so a one-tap link has to land in the right one.
    assert.match(
      resolveMarketingRequestDestination({ decision, navigationMode: "employee-portal", requestId: "req-1" }),
      /^\/employee-portals\/marketing-requests\/decision\/req-1\?decision=/,
      `a portal-shell ${decision} link must still resolve to the portal decision page`,
    );
    assert.match(
      resolveMarketingRequestDestination({ decision, navigationMode: "admin", requestId: "req-1" }),
      /^\/workspace\/marketing-requests\/decision\/req-1\?decision=/,
      `an admin-shell ${decision} link must still resolve to the workspace decision page`,
    );
  }
  // Anything that is not one of the three is NOT a decision, so it falls through to the case file
  // rather than redirecting somewhere arbitrary.
  assert.equal(parseMarketingRequestDecision("maybe"), null, "an unknown decision must not redirect");
  assert.equal(parseMarketingRequestDecision(undefined), null, "no decision means render the request");

  /* ---------------------------------------------------------------------- */
  /* redirect() must NOT sit inside the try/catch                            */
  /* ---------------------------------------------------------------------- */

  // next/navigation's redirect() signals by THROWING. Wrapped in the try/catch that renders the
  // safe state, a one-tap decision link would silently render "Could Not Load Request" instead of
  // redirecting — and it would look like an access bug, not a control-flow bug.
  const tryIndex = pageSource.indexOf("try {");
  assert.ok(tryIndex > -1, "expected a try block on this page");
  assert.ok(pageSource.includes("redirect("), "expected a redirect on this page");
  assert.equal(
    pageSource.indexOf("redirect(", tryIndex),
    -1,
    "redirect() must not appear inside or after the try/catch — it signals by THROWING, so the catch would swallow it and render 'Could Not Load Request' instead of redirecting, which reads as an access bug rather than a control-flow one",
  );

  /* ---------------------------------------------------------------------- */
  /* Fails closed, and does not leak which ids exist                         */
  /* ---------------------------------------------------------------------- */

  assert.match(
    pageSource,
    /isForbiddenError\(/,
    "a forbidden read must render a safe state, never crash the route",
  );
  assert.match(
    pageSource,
    /do not have access to this marketing request, or it does not exist/,
    "'not yours' and 'does not exist' must share one message — telling them apart lets any signed-in user probe which request ids are real",
  );
  assert.match(
    pageSource,
    /access\.source === "guest"/,
    "a signed-out visitor must be sent to log in rather than shown a forbidden page",
  );

  /* ---------------------------------------------------------------------- */
  /* The three-state contract must NOT be flattened in the UI                */
  /* ---------------------------------------------------------------------- */

  // This is the whole reason CaseFileBlock exists. A read that FAILED must never render like a read
  // that came back EMPTY.
  //
  // Scoped to the Block unwrapper's OWN body: `state === "unavailable"` also appears in the warning
  // styling below, so asserting it against the whole file passes even when Block itself has been
  // gutted. (Caught by breaking it — the unscoped version of this assertion did not fire.)
  const blockStart = viewSource.indexOf("function Block<T>");
  const blockEnd = viewSource.indexOf("/* ── warnings");
  assert.ok(blockStart > -1 && blockEnd > blockStart, "expected a Block unwrapper in this file");
  const blockBody = viewSource.slice(blockStart, blockEnd);
  assert.match(
    blockBody,
    /state === "ok"/,
    "the Block unwrapper must handle the ok state explicitly",
  );
  assert.match(
    blockBody,
    /state === "unavailable"/,
    "a failed read must render as its OWN state — collapsing 'unavailable' into an empty section is exactly the defect the case file contract exists to end",
  );
  assert.match(
    viewSource,
    /Could not be read/,
    "an unavailable block must SAY it could not be read, not render blank",
  );
  // The three warning states likewise.
  assert.match(viewSource, /state === "unavailable"[\s\S]{0,400}?clear/, "warnings must distinguish unavailable from clear");
  assert.match(
    viewSource,
    /unavailable: 1[\s\S]{0,60}?clear: 2|flagged: 0/,
    "an unrun check must outrank a passed one in the ordering — 'we could not check' is never reassurance",
  );

  /* ---------------------------------------------------------------------- */
  /* Things the audit found and this page must not reintroduce               */
  /* ---------------------------------------------------------------------- */

  assert.match(
    viewSource,
    /Raised by/,
    "the requester's own line/area/region must be labelled as the REQUESTER's — on the approval screen they sit under a Customer heading while carrying the requester's values",
  );
  // `rung.isCc ? (` — the JSX branch that renders the badge. A bare /isCc \?/ also matches the
  // React key expression a few lines above, so it survives the badge being deleted.
  assert.match(
    viewSource,
    /rung\.isCc \? \(/,
    "CC rows must be kept and tagged — 'the Product Manager was asked and said nothing' is a fact about the decision",
  );
  assert.match(
    viewSource,
    /canSeeCustomerPii/,
    "customer PII must stay tiered by viewer",
  );
  assert.match(
    viewSource,
    /confidentialWithheldCount/,
    "a withheld confidential product must be announced, never leave a silently short list",
  );
  assert.match(
    viewSource,
    /admittedAs/,
    "a viewer seeing a redacted file must be able to tell which rule admitted them",
  );

  /* ---------------------------------------------------------------------- */
  /* Both of these were caught in a real browser, against the live rejected  */
  /* request. Neither was visible from the source alone.                     */
  /* ---------------------------------------------------------------------- */

  // The page rendered "0 of 5 approvals · now with Finance Execution" for a request that was
  // REFUSED at rung 1. Nobody is holding it, and Finance never saw it. `chain.currentStepName` is
  // still populated on a terminal request, so the guard has to live here.
  assert.match(
    viewSource,
    /isInFlight && chain\.currentStepName/,
    "'now with <step>' must only render while the request is actually in flight — on a refused request it names an approver who never saw it",
  );
  assert.match(
    viewSource,
    /status === "pending_approval"/,
    "in-flight must be decided by the request's own status, not inferred from the chain",
  );

  // The same screen showed four rungs as "PENDING" on a dead request, because the decision RPC
  // never closed the remaining rungs out.
  //
  // That migration HAS since landed — a reject now marks them `skipped` in the same transaction —
  // so this is no longer the only thing between a reader and the false claim. The `pending` arm is
  // still required, because rows written before the migration exist and "pending" on a dead request
  // is the one outcome worth defending against.
  //
  // Asserted THROUGH `neverReached` rather than against a literal expression: the previous version
  // pinned the exact text `neverReached && rung.status === "pending"` and went red on a change that
  // made the guard stricter, not weaker. A test that fails when the code improves is pinning the
  // wrong thing.
  assert.match(
    viewSource,
    /const neverReached = \(rung:[\s\S]{0,320}?rung\.status === "pending"/,
    "a pending rung on a REFUSED request must not render as 'pending' — it was never reached and never will be",
  );
  // Anchored to the rendered ternary, not to the bare phrase: the component's own comment explains
  // when a rung reads "not reached", so `/not reached/` alone passes against that comment even with
  // the wording deleted from the screen. Proved by breaking it — the bare version did not fire.
  assert.match(
    viewSource,
    /\? "not reached" :/,
    "the never-reached rungs need their own wording, distinct from a live pending step",
  );
  assert.match(
    viewSource,
    /referenceStatusSentence/,
    "the pharmacy code state must render as prose, never the raw word — a 'pending' chip is a failed lookup wearing a benign label",
  );
  // A viewer admitted only as a product's owner is refused by the conversation's route, which can carry
  // the customer details they are denied. Asking anyway raised a false block on their screen (2 Nov 2026).
  assert.match(
    viewSource,
    /\{viewer\.admittedAs\.some\(\(arm\) => arm !== "product_owner"\) \? \(\s+<div className="mt-6">\s+<RecordConversationThread /,
    "the thread must not mount for a viewer its route refuses",
  );
  // Cairo, never raw UTC (standing rule).
  assert.match(
    viewSource,
    /cairoDateTime\(/,
    "recorded instants must be rendered in Africa/Cairo, never as a raw ISO string",
  );
  assert.doesNotMatch(
    viewSource,
    /toLocaleTimeString\(\)|new Date\([^)]*\)\.toISOString\(\)\.slice/,
    "no ad-hoc time formatting — the module already owns a Cairo formatter",
  );
}
