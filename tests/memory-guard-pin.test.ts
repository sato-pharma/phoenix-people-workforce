// The hook that tells a session not to start a build on a saturated 16 GB box must itself be tested.
//
// WHY THIS EXISTS. `memory-guard.mjs` is a **global** SessionStart hook — it lives in
// `~/.claude/hooks/`, not in this repository — so nothing anywhere could go red when it weakened. It
// is the fourth of the global hooks to be pinned (after the delete guard, the Next step guard and
// the risky-allow guard), and the only one that had no selftest at all: the other three were
// wirings, this one was a build. (This said "fourth and last" until a sweep on 2026-10-06 turned up
// a fifth — the dev-server reaper, `tests/dev-server-reaper-pin.test.ts`. It was never last.)
//
// 🔴 ITS FAILURE MODE IS SILENCE, AND SILENCE IS ITS HEALTHY STATE TOO. Every block in the hook is
// wrapped in `try {} catch {}` and it always exits 0 — deliberately, because a throw here would fail
// the start of every session on the machine. So a regression produces no error, no output and no
// exit code: the only symptom is a new session being told nothing while the machine sits at its
// ceiling, which looks exactly like a healthy machine. On 2026-09-11 that machine bluescreened twice
// with free RAM at 43–921 MB, losing every unsaved session, so the message this hook does or does not
// print is the difference between a session routing work to cloud and a session starting a build.
//
// WHAT MADE IT TESTABLE. The message CHOICE used to read `os.freemem()` inline inside its own
// if/else chain, so the branch taken depended on whichever machine the test ran on — the table was
// unverifiable by construction. It is now a pure `decideMessage({pct, used, lim, freeBytes, count})`,
// with the branch order, the thresholds and the message text carried over verbatim. The one genuine
// change is a fix: the RAM branch used to call `os.freemem()` twice, once to decide and once to
// print, so the number in the message was not necessarily the number that chose it.
//
// WHAT IS ASSERTED. The same three layers as `tests/verify-shipped-selftest.test.ts`,
// `tests/next-step-guard-decisions.test.ts` and `tests/risky-allow-guard-pin.test.ts`:
//   1. the selftest runs and reports 0 failed;
//   2. the case COUNT never falls — which layer 1 cannot see, because a deleted case still exits 0
//      with `0 failed`;
//   3. the load-bearing cases are present BY NAME — which neither of the others can see, because a
//      hard case swapped for an easy one keeps both the count and the exit code intact.
// Plus two this hook needs specifically: the total it prints must equal the pass lines it printed
// (the hook counts its own cases at runtime precisely so a hand-kept literal cannot drift from them —
// it printed `16` for 18 of them the first time it ran), and the mode must still be the bare word
// `selftest`, because the hourly runner names that spelling.
//
// It drives the mirrored copy as a subprocess. A green run here means the copy committed at this sha
// is sound, never that the laptop's hook is — `claude-scripts-backup.mjs` (`HOOK_SELFTESTS`) runs the
// LIVE file hourly for that half, and it exists only on the owner's machine.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = join(REPO_ROOT, ".claude", "cloud-context", "laptop-hooks", "memory-guard.mjs");

// A ratchet, not an equality: cases may RISE and must never FALL. Raised 18 -> 19 on 2026-10-06, in
// the commit that fixed the dead branch: the one case pinning that defect became three — the clause
// present when commit is unreadable, absent when it is not, and silence on a healthy machine.
const MIN_CASES = 19;

// Each of these covers a distinct way the hook can go quiet when it should speak, or speak the wrong
// thing. Matched against the selftest's own pass lines, so they prove the case RAN, not merely that
// its text is still in the file.
const LOAD_BEARING = [
  "commit at exactly 85 warns", // the >= boundary; 86 would read the box after it has already spiked
  "commit wins over low RAM when BOTH are bad", // the branch precedence
  "RAM at exactly 1800 MB says NOTHING", // the < boundary, which must match mem-watchdog.ps1's floor
  "the RAM message prints the SAME figure that chose the branch", // the double-read fix
  "a resume keeps the ORIGINAL start time", // sessions here run 6.5h median and have hit 8.9 days
  "garbage on stdin does not crash it", // it must fail OPEN — this runs at every session start
  "low RAM with an UNREADABLE commit charge says so", // the fact that had nowhere to go until 2026-10-06
  "low RAM with a READ commit charge does NOT claim it was unreadable", // the clause stays conditional
  "an unreadable commit charge on a HEALTHY machine stays SILENT", // deliberately not warned about
];

export function runMemoryGuardPinTests() {
  assert.ok(
    existsSync(HOOK),
    `the pinned copy of memory-guard.mjs must exist at ${HOOK}. ` +
      "It is produced by `node scripts/sync-cloud-context.mjs` (PINNED_HOOKS) — if that stopped mirroring it, " +
      "fix the sync rather than deleting this test, because a missing copy is how CI comes to test nothing.",
  );

  const source = readFileSync(HOOK, "utf8");

  assert.ok(
    source.includes("process.argv[2] === 'selftest'"),
    "the pinned copy must still dispatch on the BARE word `selftest`. The hourly HOOK_SELFTESTS entry in " +
      "claude-scripts-backup.mjs passes exactly that, and a renamed mode makes the hourly run exercise " +
      "nothing — silently, exiting 0, which reads as `this file has no selftest`. That is how the " +
      "risky-allow guard's suite stayed invisible for weeks; it takes `--selftest`, this one does not.",
  );

  assert.ok(
    source.includes("function decideMessage("),
    "the pinned copy must still expose the decision as a pure `decideMessage` — if the message choice " +
      "moved back inline with `os.freemem()`, the table is untestable again and this suite is measuring " +
      "whichever machine CI happens to run on.",
  );

  const run = spawnSync(process.execPath, [HOOK, "selftest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    input: "",
    timeout: 120_000,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;

  assert.equal(run.status, 0, `memory-guard.mjs selftest must exit 0.\nexit=${run.status}\n${output}`);

  const summary = /(\d+) cases, (\d+) failed/.exec(output);
  assert.ok(summary, `the selftest must print its own summary line so this test can read the counts; got:\n${output}`);

  const cases = Number(summary[1]);
  const failed = Number(summary[2]);

  assert.equal(failed, 0, `the memory guard selftest reported ${failed} failed case(s):\n${output}`);

  assert.ok(
    cases >= MIN_CASES,
    `the memory guard selftest has ${cases} cases and must never drop below ${MIN_CASES}. ` +
      "Cases were deleted, not fixed — a deleted case still exits 0 and still prints `0 failed`, which is " +
      "exactly what this ratchet exists to catch. If cases were genuinely consolidated, lower MIN_CASES in " +
      "the same commit and say why in the message.",
  );

  const passLines = (output.match(/^ {2}pass {2}/gm) || []).length;
  assert.equal(
    passLines,
    cases,
    `the selftest printed ${cases} in its summary but ${passLines} pass lines, with 0 failed. The hook counts ` +
      "its own cases at runtime precisely so those two cannot disagree — a mismatch means the counter stopped " +
      "being incremented per case, which would let cases be deleted without the ratchet above noticing.",
  );

  for (const fragment of LOAD_BEARING) {
    assert.ok(
      output.includes(fragment),
      `the memory guard selftest no longer runs the case "${fragment}". It is matched against the pass lines, ` +
        "so this fails whether the case was deleted or quietly rewritten into something weaker. Each one covers " +
        "a distinct way the hook goes quiet when it should warn, or warns with the wrong number.",
    );
  }
}
