import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * `repo-doctor --strip-idle` must offer the number it will actually deliver.
 *
 * The read-only run ends with a line telling you what `--strip-idle` would reclaim. It used to
 * compute that by summing `cacheEntries` over EVERY live worktree, while the mutating pass
 * applied three gates and stripped only what survived them. The two never had to agree, and on
 * 2026-09-02 they did not:
 *
 *     Run with --strip-idle to drop 159,776 path entries of node_modules/.next ...
 *     SKIP  _wt-panel-resize          touched 5 min ago - a session may be mid-edit
 *     SKIP  _wt-archive-reachability  2 uncommitted file(s) - exists only on this disk
 *     Stripped 0 worktree(s), 0 path entries reclaimed.
 *
 * Neither figure was wrong in isolation. The offer answered "how much cache exists" in the words
 * of "how much can I get back", which is the shape AGENTS.md rule 1 calls confidently wrong: it
 * reads as a promise, and the reader who acts on it finds nothing.
 *
 * The fix routes both callers through one `stripIdleVerdict`. What this pins is not the wording
 * of the offer but the structural property that makes it trustworthy: THE GATES EXIST IN EXACTLY
 * ONE PLACE. A fourth gate added to the strip pass and not to the offer would silently restore
 * the divergence, and no amount of testing the printed strings would notice, because both
 * numbers stay internally consistent while disagreeing with each other.
 *
 * Read through {@link stripComments} deliberately: `scripts/repo-doctor.mjs` is one of the 39
 * files the naive `/\/\*[\s\S]*?\*\//g` strip mutilates (16,989 of its 62,250 chars), and this
 * file's own prose quotes the identifiers it asserts on.
 */

const DOCTOR = path.join("scripts", "repo-doctor.mjs");

/**
 * The three refusals, by the half of each message that is unique to the gate.
 *
 * Deliberately NOT the leading `${n} uncommitted file(s)` half: the worktree inventory prints
 * that same phrase for an unrelated purpose, so matching it would fail on a file that is
 * perfectly correct. The tail is the part only the gate says.
 *
 * "exists only on this disk" also appears in the header comment explaining the gates, which is
 * exactly why {@link stripComments} runs first - a prose explanation of a rule must never be
 * counted as a second implementation of it.
 */
const REFUSALS = [
  "exists only on this disk",
  "found nowhere upstream",
  "a session may be mid-edit",
];

function doctorCode(): string {
  return stripComments(fs.readFileSync(DOCTOR, "utf8"));
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function testTheGatesLiveInExactlyOnePlace() {
  const code = doctorCode();

  assert.equal(
    occurrences(code, "function stripIdleVerdict("),
    1,
    "stripIdleVerdict is the single definition of what --strip-idle will delete under; two of " +
      "them is the divergence this test exists to stop, wearing a different hat",
  );

  assert.ok(
    occurrences(code, "stripIdleVerdict(") >= 3,
    "expected the definition plus at least two call sites (the read-only offer and the " +
      "--strip-idle pass); fewer means one caller has gone back to judging eligibility itself",
  );

  for (const refusal of REFUSALS) {
    assert.equal(
      occurrences(code, refusal),
      1,
      `the refusal ${JSON.stringify(refusal)} must be written once, inside stripIdleVerdict. A ` +
        "second copy means a caller is re-implementing a gate rather than asking for the verdict",
    );
  }
}

function testTheOfferCannotSumEveryWorktreeAgain() {
  const code = doctorCode();

  // The exact shape of the bug: a total taken across `live` with no gate applied. Matching the
  // reduce alone would be too narrow - it can be rewritten as a for-loop, which is what the fix
  // did - so the verdict check below is the load-bearing guard; this one names the original for
  // the next reader.
  //
  // `[\s\S]{0,160}?` rather than `[^)]*`, which is what this was first written as. `[^)]*` stops
  // at the FIRST `)`, and the bug text is `live.reduce((a, r) => a + cacheEntries(...))` - the
  // arrow's own parameter list closes before `cacheEntries` is ever reached, so the guard could
  // not match the single line it was written to catch. It read as a passing check for as long as
  // it took to break the fix and watch it stay GREEN.
  assert.ok(
    !/live\.reduce\([\s\S]{0,160}?cacheEntries/.test(code),
    "the read-only offer must not sum cacheEntries across every live worktree; that total is " +
      "what the command refuses to deliver",
  );

  // Whatever the offer sums, it must sit downstream of a verdict. Locate the offer by its own
  // output string, then require a stripIdleVerdict call in the block that computes it.
  const offerAt = code.indexOf("Run with --strip-idle to drop");
  assert.notEqual(offerAt, -1, "the read-only offer line is gone - this test is pinning nothing");

  const gateAt = code.indexOf("if (!fix && !stripIdle) {");
  assert.notEqual(gateAt, -1, "the read-only block guard moved; re-anchor this test");
  assert.ok(gateAt < offerAt, "expected the offer to sit inside the read-only guard");

  const offerBlock = code.slice(gateAt, offerAt);
  assert.ok(
    offerBlock.includes("stripIdleVerdict("),
    "the offer must ask stripIdleVerdict which worktrees count before advertising a total; " +
      "without it the printed number is cache that exists, not space you can get back",
  );
}

function testARefusedWorktreeIsNamedNotSwallowed() {
  const code = doctorCode();

  // A bare "nothing to reclaim" is a different lie from the original: it reads as "there is no
  // cache here" when the truth is that there is a lot of it and it is deliberately protected.
  assert.ok(
    code.includes("held back"),
    "when the offer withholds worktrees it must say so and name them, so the reader can tell " +
      "'no cache exists' apart from 'the cache is being protected'",
  );
}

function testTheRestoreAdviceOnlyPrintsWhenSomethingWasStripped() {
  const code = doctorCode();

  const at = code.indexOf("Restore any of them");
  assert.notEqual(at, -1, "the restore advice is gone - this test is pinning nothing");

  // "Restore any of them" is advice about worktrees THIS RUN emptied. Printed unconditionally it
  // trailed "Stripped 0 worktree(s), 0 path entries reclaimed", where "them" referred to nothing
  // and the sentence implied something had been removed and needed putting back. That is the
  // same failure as the offer this file already pins, one size down: output that stays true of
  // the code and false of the run it is describing.
  const before = code.slice(Math.max(0, at - 240), at);
  assert.ok(
    /stripped > 0\s*\n?\s*\?/.test(before),
    "the restore advice must sit behind a `stripped > 0` guard; after a run that stripped " +
      "nothing it tells the reader to put back something that was never taken",
  );
}

export function runRepoDoctorStripIdleOfferTests() {
  testTheGatesLiveInExactlyOnePlace();
  testTheOfferCannotSumEveryWorktreeAgain();
  testARefusedWorktreeIsNamedNotSwallowed();
  testTheRestoreAdviceOnlyPrintsWhenSomethingWasStripped();
}
