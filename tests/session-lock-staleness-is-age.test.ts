import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A session lock is stale by AGE alone. Nothing may teach a reader to judge one by its PID.
 *
 * WHY THIS EXISTS. `.claude/hooks/session-lock.mjs` writes `pid: process.ppid` — the hook's
 * short-lived parent shell, which exits within seconds of the lock being written. Its own header
 * says PID-liveness checks are "intentionally not used to decide staleness". So EVERY session lock
 * on the machine names a dead PID, forever, and "the PID is gone" is not evidence of anything.
 *
 * Three places said otherwise, and each one was read and believed:
 *
 *   1. `~/.claude/scripts/claude-hygiene.mjs` decided staleness with `pidAlive(pid)`. On 2026-09-05
 *      it reported a lock written FIVE MINUTES earlier by a live session as stale — and the
 *      scheduled task `ClaudeCode Hygiene - Weekly` runs it with `--fix`, so it had been deleting
 *      live session locks every week. That file lives outside this repository, so CI cannot see it
 *      and this test cannot reach it; it is fixed, and named here so the next reader knows where
 *      the fourth copy of this mistake would hide.
 *   2. This hook's OWN warning text — the paragraph injected into every session that opens on a
 *      locked folder — ended "if the reported PID is not a running process, the lock is stale".
 *   3. AGENTS.md said the same thing twice.
 *
 * The cost of believing it is not a stale report. It is deleting the only guard against two
 * sessions in one folder, which in this repo has meant a session git-detached by another's
 * checkout, a branch auto-deleted mid-work, and a swarm dropping a staged file.
 *
 * So what is pinned here is that the hook DECIDES by age, and that no shipped text tells anyone to
 * decide any other way.
 */

const HOOK = ".claude/hooks/session-lock.mjs";

/** Any way of asking "is this process alive", in the spellings that would actually appear here. */
const LIVENESS_CALLS = [
  "pidAlive",
  "process.kill",
  "Get-Process",
  "tasklist",
  "isProcessAlive",
  "execFileSync",
];

function testTheHookDecidesByAge() {
  const code = stripComments(readFileSync(HOOK, "utf8"));

  assert.match(
    code,
    /STALE_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    "the two-hour expiry is the whole staleness rule; if it moves, claude-hygiene.mjs's " +
      "SESSION_LOCK_STALE_MS must move with it",
  );

  // The decision itself: non-finite age OR older than the window. Nothing else.
  assert.match(
    code,
    /!Number\.isFinite\(ageMs\)\s*\|\|\s*ageMs\s*>\s*STALE_MS/,
    "staleness must be decided from the lock's AGE — an undated lock stale, an old one stale",
  );

  for (const call of LIVENESS_CALLS) {
    assert.ok(
      !code.includes(call),
      `session-lock.mjs must not ask whether a process is alive (${call}): the pid it stores is ` +
        "its own parent shell, so the answer is always 'dead' and the check always fires",
    );
  }

  // The pid may still be WRITTEN — it is a useful breadcrumb in the warning — but it must never be
  // read back to make a decision.
  assert.ok(code.includes("pid: process.ppid"), "the pid breadcrumb is expected to stay");
}

function testNoShippedTextTeachesThePidRule() {
  const hook = readFileSync(HOOK, "utf8");
  const agents = readFileSync("AGENTS.md", "utf8");

  // The exact sentence that was wrong, and the shapes a rewrite would most likely take.
  const WRONG = [
    /PID is not a running process, the lock is stale/i,
    /if the (reported )?PID is (not|no longer) (a )?running/i,
    /stale lock proves the PID is dead/i,
    /a lock whose PID is not a running process is stale/i,
  ];

  for (const source of [
    { name: HOOK, text: hook },
    { name: "AGENTS.md", text: agents },
  ]) {
    for (const pattern of WRONG) {
      assert.ok(
        !pattern.test(source.text),
        `${source.name} must not teach the PID staleness rule (${pattern}) — every session lock ` +
          "names a dead PID, so that rule condemns live sessions",
      );
    }
  }

  // And the replacement has to actually say what the rule IS, or the next reader invents one.
  assert.match(
    hook,
    /that AGE is the only staleness test/i,
    "the warning must name the real rule, not merely drop the wrong one",
  );
  assert.match(
    agents,
    /that AGE is the ONLY staleness test/,
    "AGENTS.md section 5 must carry the age rule",
  );
}

export function runSessionLockStalenessIsAgeTests() {
  testTheHookDecidesByAge();
  testNoShippedTextTeachesThePidRule();
}
