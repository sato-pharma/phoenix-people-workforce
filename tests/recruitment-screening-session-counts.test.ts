import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CandidateDecisionTab } from "../src/lib/recruitment/candidate-decision-tabs.ts";
import { emptyWorkQueueCounts } from "../src/lib/recruitment/screening-queues.ts";
import {
  decisionCountsAfterSession,
  workQueueCountsAfterSession,
  type SessionCountRow,
} from "../src/lib/recruitment/screening-session-counts.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE NUMBERS THAT DID NOT MOVE. The owner, 19 Oct 2026: "when i or the talent acquisition short
 * list someone the numbers do not change". The Screening page drew its tab strip and its rail from
 * the server once and never again, so a Shortlist press changed nothing a reader could count.
 */

const tabs = (overrides: Partial<Record<CandidateDecisionTab, number>>): Record<CandidateDecisionTab, number> => ({
  all: 0,
  backup: 0,
  hired: 0,
  new: 0,
  rejected: 0,
  sent_to_manager: 0,
  shortlisted: 0,
  ...overrides,
});

const read = (path: string) =>
  stripComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

export async function runScreeningSessionCountsTests() {
  const fresh: SessionCountRow = { id: "a", queues: ["all", "new", "recommended"], status: "new" };
  const other: SessionCountRow = { id: "b", queues: ["all", "new"], status: "new" };
  const before = tabs({ all: 10, new: 6, shortlisted: 2, rejected: 2 });

  // ── 1 · A SHORTLIST IS ONE OFF "NOT DECIDED YET" AND ONE ON "SHORTLISTED" ───────────────────
  assert.deepEqual(
    decisionCountsAfterSession(before, [fresh, other], { a: "shortlisted" }),
    tabs({ all: 10, new: 5, shortlisted: 3, rejected: 2 }),
    "shortlisting one CV must move one from Not decided yet to Shortlisted, and All must not move",
  );
  assert.deepEqual(decisionCountsAfterSession(before, [fresh, other], {}), before, "nothing decided, nothing moves");

  // UNDO puts the stored status back, which is no move at all — the number returns.
  assert.deepEqual(decisionCountsAfterSession(before, [fresh], { a: "new" }), before, "an undone decision moves nothing");

  // A SECOND VERDICT on the same CV counts once, from where the server had it.
  assert.deepEqual(
    decisionCountsAfterSession(before, [fresh], { a: "rejected" }),
    tabs({ all: 10, new: 5, shortlisted: 2, rejected: 3 }),
    "shortlisted then rejected in one sitting is one move, new to rejected",
  );

  // A decision reported for a CV this page did not load (another tab's) is not counted: its stored
  // status is unknown here, and guessing one would be a number nobody could check.
  assert.deepEqual(decisionCountsAfterSession(before, [fresh], { z: "shortlisted" }), before);

  // Never below zero, whatever the snapshot said.
  assert.equal(decisionCountsAfterSession(tabs({ new: 0 }), [fresh], { a: "shortlisted" }).new, 0);

  // ── 2 · THE RAIL ON "NOT DECIDED YET": THE DECIDED CV LEAVES EVERY PILE BUT EVERYONE ────────
  const rail = { ...emptyWorkQueueCounts(), all: 2, new: 2, recommended: 1 };
  const afterOnNew = workQueueCountsAfterSession(rail, [fresh, other], { a: "shortlisted" }, "new");
  assert.equal(afterOnNew.new, 1, "New CVs must drop by one when a CV in it is shortlisted");
  assert.equal(afterOnNew.recommended, 0, "…and so must every other pile it was in on this tab");
  assert.equal(afterOnNew.all, 2, "Everyone stays the length of the list, which still shows the row");

  // ── 3 · THE RAIL ON "ALL": ONLY THE STATUS-READING PILES MOVE ───────────────────────────────
  const onAll = workQueueCountsAfterSession(rail, [fresh], { a: "shortlisted" }, "all");
  assert.equal(onAll.new, 1, "a shortlisted CV is no longer a new one");
  assert.equal(onAll.recommended, 1, "a shortlisted CV stays recommended — screening-queues.ts keeps it");
  const rejectedOnAll = workQueueCountsAfterSession(rail, [fresh], { a: "rejected" }, "all");
  assert.equal(rejectedOnAll.recommended, 0, "a rejected CV leaves Recommended");
  assert.equal(rejectedOnAll.red_flagged, 1, "…and a rejection is red-flagged");

  // ── 4 · THE PAGE DRAWS THESE, NOT THE SNAPSHOT ──────────────────────────────────────────────
  //
  // The helpers above can be perfect and the page still print the load-time numbers, which is the
  // whole defect. So the wiring is pinned at the source, as this module's other screens are.
  const page = read("../src/components/recruitment/workstation/workstation-page-client.tsx");
  assert.match(page, /counts=\{liveDecisionCounts\}/, "the decision tab strip must draw the live counts");
  assert.match(page, /decisionCountsAfterSession\(decisionCounts, rows, sessionDecided\)/);
  assert.match(page, /onDecidedChange=\{onDecidedChange\}/, "the workstation must report its decisions up");
  // The router keeps a shown page for 30 s; after a decision the next tab must not be that copy.
  assert.match(
    page,
    /if \(decidedHere\.current\) \{\s*decidedHere\.current = false;\s*router\.refresh\(\);\s*\}\s*startTransition\(\(\) => \{\s*showImmediately\(next\);\s*router\.push\(href\);/,
    "after a decision, moving to another tab must drop the router's cached copy before it navigates",
  );

  const workstation = read("../src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(workstation, /counts=\{railCounts\}/, "the rail must draw the live counts");
  assert.match(workstation, /workQueueCountsAfterSession\(counts, rows, decided, decisionTab\)/);
  assert.match(workstation, /onDecidedChange\?\.\(decided\)/);
}
