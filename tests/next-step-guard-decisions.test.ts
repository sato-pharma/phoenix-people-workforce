// The Stop hook that enforces the owner's `Next step:` line must actually be TESTED somewhere.
//
// WHY THIS EXISTS. `next-step-capture.mjs` is a GLOBAL hook — it lives in `~/.claude/hooks/`, not in
// this repository — so until 2026-10-06 nothing anywhere could go red when it weakened. That is a
// sharper gap than an ordinary untested script, because of what every clause in it IS: each one was
// added after a measured failure reached the owner's input box and cost him a turn. The money move he
// was offered to OK from chat (2026-09-18). The placeholder he sent back unfilled (2026-09-17). Six
// consecutive turns of his own clicks quoted as ghost text (2026-09-26). Three "tell HR to …"
// messages only he can send (2026-09-29). Five approvals of records on a screen (2026-10-01). A
// regression does not throw and does not print: the reply looks correct, the box offers the wrong
// thing, and the only symptom is the owner typing something back that changes nothing.
//
// WHAT IS ASSERTED, AND WHY EXIT 0 IS NOT ENOUGH. The same three layers as
// verify-shipped-selftest.test.ts, because each is defeatable alone:
//   1. the hook's own `selftest` mode runs and reports 0 failed — catches a broken clause;
//   2. the case COUNT never falls — catches deleting a case to make a failure go away, which layer 1
//      reports as a perfectly green run;
//   3. the hardest cases are still present BY NAME — catches swapping a hard case for an easy one,
//      which keeps both the count and the exit code intact.
//
// WHAT IT CANNOT DO, STATED PLAINLY. This runs the MIRRORED copy under `.claude/cloud-context/
// laptop-hooks/`, because the live file is not in git and a CI runner has no `~/.claude` at all. So a
// green run here means "the copy committed at this sha is sound", never "the hook on the laptop is
// sound". The other half of the cover is `claude-scripts-backup.mjs` (HOOK_SELFTESTS), which runs the
// LIVE file hourly and fails its task into one Telegram message. Neither half is sufficient: this one
// can be green about a stale copy, and that one does not exist for anyone but the owner's laptop.
//
// It drives the hook as a subprocess and never imports it. The module's main body runs at import
// time, reads fd 0 and calls `process.exit` — an import would swallow this runner's own stdin and
// exit out of the middle of the suite, reporting a PREFIX of it as the whole of it.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = join(REPO_ROOT, ".claude", "cloud-context", "laptop-hooks", "next-step-capture.mjs");

// A ratchet, not an equality: cases may RISE freely and must never FALL. Raise this when you add
// cases; never lower it to turn a red test green — lowering it is the move this exists to catch.
const MIN_CASES = 31;

// The cases that carry the clauses which took the most incidents to get right. Matched on a
// distinctive fragment, so rewording a label does not fail the build but deleting the case does.
const LOAD_BEARING = [
  // 2026-10-01: ALWAYS_HIS_HANDS is ^-anchored, so "open customer links and press the certain ones"
  // slipped past it until every CLAUSE was tested with the same regex.
  "a GUI verb hiding behind a conjunction",
  // 2026-09-18: a trip payment offered as a one-line OK in chat.
  "a money move in the quoted words",
  // 2026-09-29: three "tell HR to …" messages, each of which reads exactly like a decision.
  "a message HE sends to a person",
  // The infinite-loop guard. Without it the hook blocks its own continuation, forever.
  "stop_hook_active disarms the block",
  // 2026-09-18: explaining this hook reproduced its own block, because a QUOTED merge claim in the
  // body read as a claim the reply was making in its own voice.
  "a QUOTED merge claim in the body is not a claim",
  // 2026-09-18: the owner watched his box read "<no suggestion>" turn after turn.
  "no quoted words at all",
];

export function runNextStepGuardDecisionsTests() {
  assert.ok(
    existsSync(HOOK),
    `the pinned copy of next-step-capture.mjs must exist at ${HOOK}. ` +
      "It is produced by `node scripts/sync-cloud-context.mjs` (PINNED_HOOKS) — if that stopped mirroring it, " +
      "fix the sync rather than deleting this test, because a missing copy is exactly how CI comes to test nothing.",
  );

  const source = readFileSync(HOOK, "utf8");
  assert.ok(
    source.includes("decision: 'block'"),
    "the pinned copy must be the real Stop hook — it no longer contains the block decision it exists to emit, " +
      "so either the mirror picked up the wrong file or the hook stopped blocking altogether.",
  );

  const run = spawnSync(process.execPath, [HOOK, "selftest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // The selftest needs no network, no token and no `~/.claude`: it redirects USERPROFILE/HOME at
    // each child so the hook's capture directory and its 7-day prune land in a temp folder. Stripping
    // the tokens proves it never reaches for one.
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    timeout: 180_000,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;

  assert.equal(
    run.status,
    0,
    `next-step-capture.mjs selftest must exit 0 with no network and no gh token.\nexit=${run.status}\n${output}`,
  );

  const summary = /(\d+) cases, (\d+) failed/.exec(output);
  assert.ok(summary, `the selftest must print its own summary line so this test can read the counts; got:\n${output}`);

  const cases = Number(summary[1]);
  const failed = Number(summary[2]);

  assert.equal(failed, 0, `the next-step guard selftest reported ${failed} failed case(s):\n${output}`);

  assert.ok(
    cases >= MIN_CASES,
    `the next-step guard selftest has ${cases} cases and must never drop below ${MIN_CASES}. ` +
      "Cases were deleted, not fixed — a green run with fewer cases is exactly what this ratchet exists to catch. " +
      "If cases were genuinely consolidated, lower MIN_CASES in the same commit and say why in the message.",
  );

  for (const fragment of LOAD_BEARING) {
    assert.ok(
      output.includes(fragment),
      `the next-step guard selftest no longer covers "${fragment}". ` +
        "Each of these encodes a clause that took a real incident to get right, and without its case the clause " +
        "can be removed with the count and the exit code both intact.",
    );
  }

  // The summary says 0 failed, but a case that threw before reporting appears in neither column — so
  // the pass lines are counted too, exactly as verify-shipped-selftest.test.ts does.
  const passLines = (output.match(/^\s*pass\s{2}/gm) || []).length;
  assert.equal(
    passLines,
    cases,
    `the selftest printed ${passLines} pass line(s) for ${cases} case(s). A case that threw before reporting ` +
      `shows up in neither column, so the counts must agree.\n${output}`,
  );
}
