import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BATCH_ACTOR_PREFIX, isBatchActor } from "../src/lib/recruitment/batch-actor.ts";

/**
 * Telling an automated sweep apart from a person.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
 *
 * `ops:non-egyptian-reject-20260828` rejected 65 candidates in one pass. The screening throughput
 * trend shipped without this check and showed 138 decisions for the week of 08-29 against a true 73
 * — telling the owner his backlog had SHRUNK BY 69 when it had held level at -4.
 *
 * Worse than a wrong number, it rewards the wrong action: a week read as a triumph teaches that
 * running another sweep is how the line goes down.
 *
 * The same artefact reached the hiring-analytics plan, where "email converts at 50% against
 * WhatsApp's 16%" was really 23% against 18% once the sweep came out — 58 swept CVs standing in for
 * a 3x channel advantage that would have justified moving recruitment spend.
 *
 * ── WHY A PREFIX AND NOT THE NAME ───────────────────────────────────────────────────────────────
 *
 * The next batch will be called something else. Matching `ops:non-egyptian-reject-20260828` exactly
 * would pass every future sweep straight back into the numbers, with nothing to show that it had.
 */
export function runRecruitmentBatchActorTests() {
  assert.equal(BATCH_ACTOR_PREFIX, "ops:", "the marker is a prefix, not a name");

  assert.ok(isBatchActor("ops:non-egyptian-reject-20260828"), "the sweep that caused this is a batch");
  assert.ok(isBatchActor("ops:some-future-sweep-20270101"), "and so is one that does not exist yet");
  assert.ok(isBatchActor("OPS:UPPERCASED"), "case must not smuggle one past");
  assert.ok(isBatchActor("  ops:padded  "), "and neither may whitespace");

  assert.ok(!isBatchActor("B-10"), "a real HR id is not a batch");
  assert.ok(!isBatchActor("hr-010"), "in either casing");
  assert.ok(!isBatchActor(null), "nothing is not a batch");
  assert.ok(!isBatchActor(""), "and neither is blank");
  // The one that would be easy to get wrong: an id that merely CONTAINS the marker is not a batch,
  // because the contract is how the value STARTS.
  assert.ok(!isBatchActor("B-10-ops:something"), "the prefix must anchor at the start");

  // ── THE CONSUMER THAT MATTERS ─────────────────────────────────────────────────────────────────
  //
  // Pinned here rather than only in the throughput suite, because the throughput suite tests
  // arithmetic and this is a question about its INPUT — the exact gap that let the bug ship.
  const service = readFileSync(path.join(process.cwd(), "src/lib/recruitment/candidates.ts"), "utf8");
  assert.match(
    service,
    /\.select\("candidate_id,created_at,to_status,actor_hr_id"\)/,
    "the decision history must READ the actor — without it nothing downstream can tell a sweep from " +
      "a week of work",
  );
  assert.match(
    service,
    /if \(isBatchActor\(row\.actor_hr_id\)\) continue;/,
    "and it must skip batches, through this shared helper rather than a second copy of the rule",
  );
}
