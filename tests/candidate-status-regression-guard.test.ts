import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  candidateStatuses,
  normalizeCandidateStatus,
  statusChangeRefusal,
} from "../src/lib/recruitment/candidate-status.ts";

/**
 * A CV that has been sent to a hiring manager cannot be quietly walked back to the shelf.
 *
 * MEASURED, 2026-09-08. Fifty candidates held a row in `ats_candidate_manager_sends` naming a
 * manager, a position and a time — they had been sent — while their status read `shortlisted`. The
 * event trail showed each send followed 1.5–2.5 SECONDS later by a move back to `shortlisted`
 * carrying no note:
 *
 *   new → sent_to_manager        01:38:28.17   "Sent to Magdy El Senosey for Alex West · Medical Rep"
 *   sent_to_manager → shortlisted   01:38:29.67   (no note)
 *
 * NOT a race and NOT a machine, though both were suspected in turn. The bulk-status route was ruled
 * out by the data: it runs one RPC per transaction, so it would stamp dozens of candidates in a
 * single second, and these reverts are one per second at most, scattered seconds to a minute apart.
 * It was `Shortlist` — an icon button sitting next to `Send to manager` in a dense row, disabled
 * only when the candidate was ALREADY shortlisted, so after a send it stayed live and labelled
 * plainly "Shortlist". Two clicks, two seconds apart, fifty times.
 *
 * The cost was not cosmetic: every screen keying off status showed those fifty as not yet sent, so
 * they could be sent to the same manager twice, and the overdue-feedback queue undercounted by
 * fifty against a reported total of thirteen.
 */
export function runCandidateStatusRegressionGuardTests() {
  // ── The one transition that is refused ────────────────────────────────────────────────────────
  const refusal = statusChangeRefusal("sent_to_manager", "shortlisted");
  assert.ok(refusal, "a sent CV must not be movable back to shortlisted");
  assert.match(refusal!, /already been sent/i, "the sentence must say what the candidate's actual state is");
  assert.match(refusal!, /Reject|Undo/, "a refusal must name the way forward, not just say no");

  // ── And EVERY other transition still passes ──────────────────────────────────────────────────
  // The guard is deliberately one rule. Inventing a state machine from a single incident is how a
  // screen acquires refusals nobody can explain, so anything not measured stays allowed.
  let refused = 0;
  for (const from of candidateStatuses) {
    for (const to of candidateStatuses) {
      const result = statusChangeRefusal(from, to);
      if (result) {
        refused += 1;
        assert.equal(from, "sent_to_manager", `unexpected refusal from ${from}`);
        assert.equal(to, "shortlisted", `unexpected refusal to ${to}`);
      }
    }
  }
  assert.equal(refused, 1, "exactly one transition may be refused — the one that actually went wrong");

  // Specifically still allowed, because each is real recruitment work:
  assert.equal(statusChangeRefusal("sent_to_manager", "rejected"), null, "a manager saying no must still record");
  assert.equal(statusChangeRefusal("sent_to_manager", "hired"), null, "a hire after a send is the happy path");
  assert.equal(statusChangeRefusal("shortlisted", "sent_to_manager"), null, "the forward move is the point");
  assert.equal(statusChangeRefusal("new", "shortlisted"), null, "ordinary screening is untouched");
  assert.equal(statusChangeRefusal("rejected", "shortlisted"), null, "reconsidering a rejection is allowed");

  // Unknown or absent values are NOT the guard's business — normalizeCandidateStatus owns that, and
  // answering "refused" here would turn a typo into a wall with the wrong explanation on it.
  assert.equal(statusChangeRefusal(null, "shortlisted"), null);
  assert.equal(statusChangeRefusal("sent_to_manager", null), null);
  assert.equal(statusChangeRefusal("not-a-status", "shortlisted"), null);
  // THE GUARD'S INPUT CONTRACT, written down because I asserted the opposite first and was wrong.
  //
  // `normalizeCandidateStatus` folds LEGACY names and trims whitespace; it does NOT fold casing on a
  // canonical value, so "Sent_To_Manager" resolves to null and the guard allows the move. That is
  // acceptable ONLY because both real callers hand it canonical values: the server reads
  // `existing.status` straight from the column, and `next` has already been through the normaliser
  // before the guard is asked. Pinned so that a future caller passing raw user input fails here
  // rather than becoming a silently unguarded transition in production.
  assert.equal(statusChangeRefusal("Sent_To_Manager", "shortlisted"), null, "canonical casing IS the contract");
  assert.equal(normalizeCandidateStatus("Sent_To_Manager"), null, "the normaliser does not fold canonical casing");

  // ── The server enforces it, not only the button ──────────────────────────────────────────────
  //
  // A disabled control is UX. `updateCandidateStatus` is the only place that reads the CURRENT
  // status, which is what the rule is about, and the same request arrives just as easily from a
  // stale tab or a double submit.
  const repoRoot = path.resolve(process.cwd());
  const service = fs.readFileSync(path.join(repoRoot, "src/lib/recruitment/candidates.ts"), "utf8");
  assert.match(
    service,
    /const refusal = statusChangeRefusal\(existing\.status, next\);\s*\n\s*if \(refusal\) throw new Error\(refusal\);/,
    "updateCandidateStatus must refuse the move server-side",
  );
  // Ordering matters twice: after the row is loaded (the rule needs the stored status) and before
  // the write (the obvious reason).
  const loadAt = service.indexOf("const existing = await getCandidate(id);");
  const guardAt = service.indexOf("const refusal = statusChangeRefusal(existing.status, next);");
  const writeAt = service.indexOf('.from("ats_candidates")\n    .update({');
  assert.ok(loadAt > 0 && guardAt > loadAt, "the guard must run after the candidate is loaded");
  assert.ok(writeAt > 0 && guardAt < writeAt, "the guard must run before the write");

  // ── The button asks the domain rather than restating the rule ────────────────────────────────
  const workspace = fs.readFileSync(
    path.join(repoRoot, "src/components/recruitment/recruitment-workspace.tsx"),
    "utf8",
  );
  assert.match(
    workspace,
    /statusChangeRefusal\(current, "shortlisted"\)/,
    "the Shortlist control must ask the shared rule, not carry its own copy",
  );
  // The exact test that caused this. If it comes back, so does the defect.
  assert.doesNotMatch(
    workspace,
    /disabled=\{pending \|\| current === "shortlisted"\}/,
    'the Shortlist button must not be disabled on `current === "shortlisted"` alone — that test left it live after a send',
  );
  assert.match(workspace, /Already sent to a manager/, "a disabled button must say WHY it is disabled");

  // The normaliser is what both sides route through; if it stopped folding these, the guard would
  // silently pass everything.
  assert.equal(normalizeCandidateStatus("sent_to_manager"), "sent_to_manager", "the canonical value round-trips");
}
