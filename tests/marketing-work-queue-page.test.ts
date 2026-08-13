import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// /marketing-requests — the work queue.
//
// The route had NO page. Only /marketing-requests/[requestId] existed, so the parent of every
// notification deep link, every "Open the full record" link and every hand-typed URL resolved to
// nothing. Work lived on an approver inbox inside one shell that a viewer had to already know to
// look for.
//
// The two rules this page cannot break:
//
//   1. A FAILED READ IS NOT AN EMPTY QUEUE. "You have nothing to do" and "we could not find out
//      what you have to do" are opposite answers; rendering the first when the second is true is
//      how somebody misses an approval on a live request. Same contract as the Case File.
//
//   2. The queue is scoped by the ACTOR, not by a role switch in the page.
//      getApproverPendingRequests returns the rungs assigned to this person. A role check here
//      would be a second, weaker gate that can drift from the real one.
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export async function runMarketingWorkQueuePageTests() {
  const page = source("app/marketing-requests/page.tsx");

  /* ---------------------------------------------------------------------- */
  /* 1. A failed read is never an empty queue                               */
  /* ---------------------------------------------------------------------- */

  assert.match(
    page,
    /try \{\s*\n\s*workspace = await getApproverPendingRequests\(access\);\s*\n\s*\} catch \{/,
    "the queue read must be guarded — an unhandled throw is a blank screen with no explanation",
  );
  assert.match(
    page,
    /Your queue could not be read\./,
    "a failed read must say so in words",
  );
  assert.match(
    page,
    /This is not the same as having nothing to do/,
    "the failure must explicitly warn that it is NOT an empty list — that is the whole defect class",
  );
  // The catch must return before any list renders, or the failure state and an empty queue both
  // appear and the reader picks whichever they see first.
  const catchAt = page.indexOf("} catch {");
  const destructureAt = page.indexOf("const { advisoryRows, rows, upcomingRows }");
  assert.ok(catchAt > -1 && destructureAt > -1 && catchAt < destructureAt, "expected the catch to precede the render");
  const catchBlock = page.slice(catchAt, destructureAt);
  assert.match(
    catchBlock,
    /return \(/,
    "the failure branch must RETURN, not fall through into rendering an empty queue",
  );

  // And the success-but-empty case must be distinguishable from it.
  assert.match(
    page,
    /This is a read that succeeded and found nothing/,
    "an genuinely empty queue must say the read succeeded, so it cannot be confused with a failure",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. Scoped by actor, not by a role switch in the page                    */
  /* ---------------------------------------------------------------------- */

  assert.match(
    page,
    /await getApproverPendingRequests\(access\)/,
    "the queue must come from the actor-scoped loader",
  );
  assert.ok(
    !/access\.role ===/.test(page) && !/PhoenixRole/.test(page),
    "the page must not re-decide visibility by role — that is a second gate that can drift from the real one",
  );

  /* ---------------------------------------------------------------------- */
  /* 3. All three queues are surfaced                                        */
  /* ---------------------------------------------------------------------- */

  assert.match(page, /Needs my action/, "the decisions the viewer owes must be the headline section");
  assert.match(page, /Waiting for my comment/, "CC reviewers must see what is open for their comment");
  // Owner instruction 2026-08-04: an approver must see what is COMING, not only what has arrived.
  assert.match(page, /Coming to you/, "requests heading toward the viewer must be visible before they arrive");
  assert.match(
    page,
    /upcomingRows\.map/,
    "the upcoming queue must actually be rendered, not merely read",
  );
  assert.match(
    page,
    /\{row\.ageDays\} day/,
    "an upcoming request must show its age — the number that makes a stall visible",
  );
  assert.match(
    page,
    /row\.awaitingStepName \?\? "no open step"/,
    "where a request is stopped must be named, and a chain with no open step must say that rather than render blank",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. Every row reaches the full record                                    */
  /* ---------------------------------------------------------------------- */

  assert.match(
    page,
    /href=\{`\/marketing-requests\/\$\{row\.id\}`\}/,
    "every row must open the case file — a queue that cannot be drilled into is a dead end",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. Owner rules                                                          */
  /* ---------------------------------------------------------------------- */

  assert.match(
    page,
    /cairoDateTime\(row\.submittedAt\)/,
    "instants must render in Africa/Cairo, never as a raw UTC string",
  );
  // Mobile never gets a table. A queue is read on a phone more than anywhere else.
  assert.ok(
    !/<table/.test(page),
    "the queue must be cards at every width — the owner's rule is that mobile never gets a table",
  );
  // Never truncate with an ellipsis (standing owner rule).
  //
  // Read from the CLASS LISTS only, not from the file. A bare /truncate/ over the source matches
  // this page's own comment explaining that nothing is truncated, so the assertion passes on prose
  // while a real `truncate` class sits in the markup — which is exactly how it failed its first run.
  const classLists = (page.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? []).join(" ");
  assert.ok(classLists.length > 0, "expected to find class lists to inspect");
  assert.ok(
    !/\btruncate\b/.test(classLists) &&
      !/\btext-ellipsis\b/.test(classLists) &&
      !/\bline-clamp-/.test(classLists),
    "nothing may be truncated or ellipsised — a request code the reader cannot finish reading is not a link they can trust",
  );
  assert.match(
    page,
    /export const dynamic = "force-dynamic";/,
    "a personal work queue must never be statically cached and served to the wrong person",
  );
}
