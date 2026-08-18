import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { marketingHistoryHeadline } from "../src/lib/marketing-requests/case-file-service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Every comment is visible, including the ones the step row cannot hold.
//
// postMarketingAdvisoryComment writes a reviewer's comment into ONE text column on their CC step
// (`decision_note`), so posting a second comment replaces the first and the row can only ever show
// the latest. Proved on staging: two comments one hour apart leave the row holding only the second.
//
// The marketing_request_steps_capture_event trigger (#2082) already records each write as its own
// `step_commented` event, so the earlier comment survives in the database — but until this change
// NOTHING READ IT. A preserved comment nobody can see is indistinguishable from a destroyed one for
// anyone actually using the app, which is why "the events table exists" was not the fix.
//
// Two rules this must not break:
//   · a failed read is `unavailable`, NEVER an empty timeline — "nothing happened" and "we could
//     not find out what happened" are the two answers the whole CaseFileBlock contract separates
//   · a NULL actor renders as "not recorded", NEVER as "the system" — the second invents an actor
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The body of one function, so an assertion cannot pass by matching unrelated code elsewhere. */
function functionBody(text: string, declaration: string) {
  const start = text.indexOf(declaration);
  assert.ok(start > -1, `expected to find ${declaration}`);
  const next = text.indexOf("\nfunction ", start + declaration.length);
  const alsoNext = text.indexOf("\nexport function ", start + declaration.length);
  const ends = [next, alsoNext].filter((i) => i > -1);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

export async function runMarketingRequestHistoryTests() {
  /* ---------------------------------------------------------------------- */
  /* 1. The headline is prose, and never invents an actor                    */
  /* ---------------------------------------------------------------------- */

  const commented = marketingHistoryHeadline(
    { from_status: null, kind: "step_commented", step_name: "SFE Validation", to_status: null },
    "Ahmed Fathy",
  );
  assert.match(commented, /Ahmed Fathy/, "the commenter must be named");
  assert.match(commented, /commented/, "the entry must say what happened, in words");
  assert.match(commented, /SFE Validation/, "the rung the comment sits on must be named");
  assert.ok(
    !/step_commented/.test(commented),
    "a raw event kind must never reach the screen — the owner's rule is human-readable names, never codes",
  );

  // The one substitution that turns a gap in the record into a false statement about who acted.
  const anonymous = marketingHistoryHeadline(
    { from_status: null, kind: "step_commented", step_name: "SFE Validation", to_status: null },
    null,
  );
  assert.match(
    anonymous,
    /not recorded/i,
    "an event with no actor must say the actor was not recorded",
  );
  assert.ok(
    !/system/i.test(anonymous),
    'an unrecorded actor must NEVER render as "the system" — that asserts something the record does not say',
  );

  // A decision names the person and what they decided.
  const decided = marketingHistoryHeadline(
    { from_status: "current", kind: "step_decided", step_name: "CEO Approval", to_status: "approved" },
    "Omar Gawish",
  );
  assert.match(decided, /Omar Gawish/, "the decider must be named");
  assert.match(decided, /approved/, "the decision must be stated");

  // A rung a REFUSAL closed out reaches this same branch. The reject marks every waiting rung
  // 'skipped' — a status change — so the capture trigger records `step_decided` with
  // decision_by_hr_id still null, and falls back to assigned_hr_id for the actor. Proved on
  // staging: rejecting at sequence 1 wrote two such rows carrying the ASSIGNEE's hr_id. Naming
  // that person would state they skipped their own step, which never happened.
  const closedOut = marketingHistoryHeadline(
    { from_status: "pending", kind: "step_decided", step_name: "Finance Execution", to_status: "skipped" },
    "Mona Adel",
  );
  assert.ok(
    !/Mona Adel/.test(closedOut),
    "a rung the refusal closed out must NOT name its assignee — they did not skip it, the refusal ended the chain above them",
  );
  assert.match(
    closedOut,
    /closed out without a decision/i,
    "a rung the refusal closed out must say so, rather than reading as an action somebody took",
  );
  assert.match(closedOut, /Finance Execution/, "the rung that was closed out must still be named");

  // The DB's status vocabulary is snake_case; underscores are not for reading.
  const statusChanged = marketingHistoryHeadline(
    { from_status: "pending_approval", kind: "request_status_changed", step_name: null, to_status: "rejected" },
    null,
  );
  assert.ok(
    !/_/.test(statusChanged),
    "underscores from the database vocabulary must not survive into the sentence",
  );
  assert.match(statusChanged, /pending approval/, "the previous status must be readable");
  assert.match(statusChanged, /rejected/, "the new status must be readable");

  const created = marketingHistoryHeadline(
    { from_status: null, kind: "request_created", step_name: null, to_status: "draft" },
    "Ahmed Fathy",
  );
  assert.match(created, /raised the request/, "creation must read as a person raising the request");

  /* ---------------------------------------------------------------------- */
  /* 2. The loader: a failed read is never an empty history                  */
  /* ---------------------------------------------------------------------- */

  const serviceSource = source("src/lib/marketing-requests/case-file-service.ts");
  const loader = functionBody(serviceSource, "async function loadHistoryBlock(");

  assert.match(
    loader,
    /if \(result\.error\) \{\s*\n?\s*return caseFileUnavailable\(/,
    'a failed read must return `unavailable` — an empty list would render as "nothing ever happened"',
  );
  assert.match(
    loader,
    /\.eq\("request_id", requestId\)/,
    "the history must be scoped to this request",
  );
  // Ties matter: the backfill wrote several rows carrying the same historical timestamp, so
  // occurred_at alone does not determine an order and the list would shuffle between reads.
  assert.match(
    loader,
    /\.order\("occurred_at", \{ ascending: true \}\)\s*\n?\s*\.order\("id", \{ ascending: true \}\)/,
    "events must be ordered oldest-first, with id breaking ties so the order is stable",
  );
  assert.match(
    loader,
    /entries\.filter\(\(entry\) => entry\.kind === "step_commented"\)\.length/,
    "the comment count must come from the events — it is the number the step row cannot tell you",
  );
  assert.match(
    loader,
    /const actorName = name === "" \? null : name;/,
    'an unresolved actor must become null, so the headline says "not recorded" rather than naming nobody',
  );
  assert.match(
    loader,
    /isBackfilled: row\.payload\?\.backfilled === true \|\| row\.payload\?\.backfilled === "true"/,
    "a row derived by the backfill must be flagged, so a reconstruction is never mistaken for a witness",
  );
  assert.match(
    loader,
    /cairoDateTime\(row\.occurred_at\)/,
    "timestamps must be Cairo-formatted server-side — the owner's standing rule is never raw UTC",
  );
  // Never present a short list as a complete one.
  assert.match(
    loader,
    /coverageSentence:/,
    "the history must state the limit of its own record, because events only start on 2026-08-13",
  );

  /* ---------------------------------------------------------------------- */
  /* 3. It is a three-state block, and it is composed in                     */
  /* ---------------------------------------------------------------------- */

  const typesSource = source("src/lib/marketing-requests/case-file-types.ts");
  assert.match(
    typesSource,
    /history: CaseFileBlock<MarketingCaseFileHistory>;/,
    "history must be a three-state block like every other fallible section, not a bare array",
  );

  // The identifier is matched loosely on purpose: what is pinned is that the call sits INSIDE the
  // Promise.all batch (hence the trailing comma), not what the request id variable happens to be
  // called — it was renamed once already when the Case File learned to accept a request code.
  assert.match(
    serviceSource,
    /loadHistoryBlock\(supabase, \w+, nameOf\),/,
    "the history must be loaded in the same parallel batch — every round trip crosses the Atlantic",
  );
  assert.match(
    serviceSource,
    /^\s{4}history: historyBlock,$/m,
    "the loaded block must actually reach the returned case file",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. The page renders it                                                  */
  /* ---------------------------------------------------------------------- */

  const view = source("src/components/marketing-requests/marketing-request-case-file.tsx");

  assert.match(
    view,
    /<Block block=\{history\}>\{\(value\) => <History history=\{value\} \/>\}<\/Block>/,
    "the history must be unwrapped through Block, so a failed read renders as a failure and not as silence",
  );
  const historyComponent = functionBody(view, "function History({ history }");
  // `>` anchors this to JSX CHILD position — i.e. text on the screen. Without it the regex also
  // matches `${entry.kind}` inside the React key, which is not rendered, and the assertion passes
  // for the wrong reason. That is exactly how it failed its own first run.
  assert.ok(
    !/>\{entry\.kind\}/.test(historyComponent),
    "the raw event kind must never be printed — every kind has a sentence",
  );
  assert.match(
    historyComponent,
    />\{entry\.headline\}/,
    "each entry must render its prose headline",
  );
  assert.match(
    historyComponent,
    /\{entry\.atLabel\}/,
    "each entry must show when it happened, in Cairo time",
  );
  assert.match(
    historyComponent,
    /\{entry\.note\}/,
    "the comment text itself must be rendered — it is the whole point of the section",
  );
  assert.match(
    historyComponent,
    /entry\.isBackfilled \?/,
    "a reconstructed entry must be labelled as one, never shown as if it had been witnessed",
  );
  assert.match(
    historyComponent,
    /\{history\.coverageSentence\}/,
    "the coverage limit must be on screen, not just in the data",
  );
}
