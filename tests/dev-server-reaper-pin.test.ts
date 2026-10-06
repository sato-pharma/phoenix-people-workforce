// The hook that STOPS processes on this machine must itself be tested.
//
// WHY THIS EXISTS. `dev-server-reaper.mjs` is a **global** hook — it lives in `~/.claude/hooks/`, not
// in this repository — so nothing anywhere could go red when it weakened. It is the fifth and last of
// the global hooks to be pinned (after the delete guard, the Next step guard, the risky-allow guard
// and the memory guard), and it is the one with the most teeth: the other four refuse, warn or
// rewrite, and this one ends a running process.
//
// 🔴 IT WAS ALREADY TESTED AND THE TESTS HAD NEVER RUN. A sweep on 2026-10-06 found a 68-case suite
// inside it that was named in nothing — not `PINNED_HOOKS` above, not `claude-scripts-backup.mjs`'s
// hourly `HOOK_SELFTESTS`, not a repo test. It had been invisible for exactly the reason the
// risky-allow guard's suite was: it dispatches on `--selftest`, so `node dev-server-reaper.mjs
// selftest` prints nothing and exits 0 — evidence that is identical to a file with no selftest at
// all. That is why the first assertion below is about the FLAG and not about the behaviour.
//
// 🔴 WHAT A REGRESSION HERE ACTUALLY COSTS. The owner's standing rule is "NEVER CLOSE THE DEV UNTIL I
// TELL U" (2026-09-21), scoped on 2026-09-28 so a session may stop one it started itself. This hook
// is what keeps that rule true mechanically: it stops a dev server only when an unbroken parent chain
// proves the ending session started it, and hands the port to another open session that is still
// using it. Every load-bearing case below is a way of answering "no, that one is NOT yours". Weaken
// one and the hook stops the owner's server, or another session's, in the middle of their work — and
// it will do it silently, because every path in the hook exits 0 by design.
//
// WHAT IS ASSERTED. The same three layers as `tests/verify-shipped-selftest.test.ts`,
// `tests/next-step-guard-decisions.test.ts`, `tests/risky-allow-guard-pin.test.ts` and
// `tests/memory-guard-pin.test.ts`:
//   1. the selftest runs and reports 0 failed;
//   2. the case COUNT never falls — which layer 1 cannot see, because a deleted case still exits 0
//      with `0 failed`;
//   3. the load-bearing cases are present BY NAME — which neither of the others can see, because a
//      hard case swapped for an easy one keeps both the count and the exit code intact.
// Plus two this hook needs specifically: the printed total must equal the pass lines it printed, and
// the mode must still be the exact flag `--selftest`, because the hourly runner names that spelling
// and a rename makes the hourly run exercise nothing, silently, for ever.
//
// SAFE TO RUN IN CI. The suite is pure functions only — it starts and ends no process, and the
// subprocess below is pointed at a temp HOME so neither the live reaper state directory nor its log
// is touched even if a future case reaches for one.
//
// It drives the mirrored copy as a subprocess. A green run here means the copy committed at this sha
// is sound, never that the laptop's hook is — `claude-scripts-backup.mjs` (`HOOK_SELFTESTS`) runs the
// LIVE file hourly for that half, and it exists only on the owner's machine.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = join(REPO_ROOT, ".claude", "cloud-context", "laptop-hooks", "dev-server-reaper.mjs");

// A ratchet, not an equality: cases may RISE and must never FALL. 68 as of 2026-10-06, the count the
// suite printed the first time anything ran it.
const MIN_CASES = 68;

// Every one of these is a case that answers "that process is NOT this session's to stop". They are
// matched against the selftest's own pass lines, so this fails whether a case was deleted or quietly
// rewritten into something weaker.
const LOAD_BEARING = [
  "chainTo another engine", // another session's server — the whole point of the ownership proof
  "chainTo broken by a parent younger than its child", // a recycled PID must break the chain, not forge one
  "chainTo stops at a nested engine", // a session inside a session owns its own children
  "subtree skips a child created before its parent (recycled PID)", // same trap, walking downwards
  "verifyRoot different creation time", // the PID came back as something else between record and stop
  "verifyRoot different command line", // ditto, caught on the third of the three recorded fields
  "processLabel claude.exe", // never stop the engine itself
  "processLabel cmd.exe", // never stop a shell
  "commandLabel | pnpm run build", // a build is not a dev server and must never be reaped as one
  "parseNetstat keeps listeners only", // an ESTABLISHED connection is a CLIENT, not the server
  "borrowPorts in a browser payload", // how another open session's use of the port is seen at all
  "REAPER_HINT ignores an ordinary command", // the hook must not wake on every command the session runs
];

export function runDevServerReaperPinTests() {
  assert.ok(
    existsSync(HOOK),
    `the pinned copy of dev-server-reaper.mjs must exist at ${HOOK}. ` +
      "It is produced by `node scripts/sync-cloud-context.mjs` (PINNED_HOOKS) — if that stopped mirroring it, " +
      "fix the sync rather than deleting this test, because a missing copy is how CI comes to test nothing.",
  );

  const source = readFileSync(HOOK, "utf8");

  assert.ok(
    source.includes("mode === '--selftest'"),
    "the pinned copy must still dispatch on the exact flag `--selftest`. The hourly HOOK_SELFTESTS entry in " +
      "claude-scripts-backup.mjs passes exactly that, and a renamed mode makes the hourly run exercise nothing — " +
      "silently, exiting 0, which reads as `this file has no selftest`. That is precisely how this suite and the " +
      "risky-allow guard's stayed invisible: the other three global hooks take the BARE word `selftest`, so a " +
      "sweep for the bare word finds nothing here and concludes there is nothing to find.",
  );

  assert.ok(
    source.includes("function chainTo(") && source.includes("function verifyRoot("),
    "the pinned copy must still expose ownership as `chainTo` (an unbroken parent chain up to the ending " +
      "session's engine) and `verifyRoot` (PID, creation time and command line all re-read before the stop). " +
      "Those two ARE the owner's rule that a session never stops a server it did not start — if either is gone, " +
      "the cases below are testing something that no longer decides anything.",
  );

  // A temp HOME so neither ~/.claude/scripts/dev-server-reaper/ nor its log is touched. The suite is
  // pure functions today; this keeps that true for whoever adds the next case.
  const sandbox = mkdtempSync(join(tmpdir(), "phx-reaper-pin-"));

  const run = spawnSync(process.execPath, [HOOK, "--selftest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: sandbox,
      USERPROFILE: sandbox,
      PHX_REAPER_STATE_DIR: join(sandbox, "reaper-state"),
      PHX_REAPER_LOG: join(sandbox, "reaper.log"),
    },
    input: "",
    timeout: 120_000,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;

  assert.equal(
    run.status,
    0,
    `dev-server-reaper.mjs --selftest must exit 0. It exits 1 when any case fails, so a non-zero status here is ` +
      `a real regression and not a harness problem.\nexit=${run.status}\n${output}`,
  );

  const summary = /SELFTEST dev-server-reaper: (\d+) cases, (\d+) failed/.exec(output);
  assert.ok(
    summary,
    `the selftest must print its own summary line so this test can read the counts; got:\n${output}`,
  );

  const cases = Number(summary[1]);
  const failed = Number(summary[2]);

  assert.equal(failed, 0, `the dev-server reaper selftest reported ${failed} failed case(s):\n${output}`);

  assert.ok(
    cases >= MIN_CASES,
    `the dev-server reaper selftest has ${cases} cases and must never drop below ${MIN_CASES}. ` +
      "Cases were deleted, not fixed — a deleted case still exits 0 and still prints `0 failed`, which is " +
      "exactly what this ratchet exists to catch. If cases were genuinely consolidated, lower MIN_CASES in " +
      "the same commit and say why in the message.",
  );

  const passLines = (output.match(/^PASS {2}/gm) || []).length;
  assert.equal(
    passLines,
    cases,
    `the selftest printed ${cases} in its summary but ${passLines} pass lines, with 0 failed. The suite counts ` +
      "its own cases at runtime so those two cannot disagree — a mismatch means the counter stopped being " +
      "incremented per case, which would let cases be deleted without the ratchet above noticing.",
  );

  // 🔴 ANCHORED, not a free-floating `output.includes(fragment)`, which is what this loop used when it
  // was written on 2026-10-06 — and which had a hole: a fragment is a SUBSTRING of a renamed case, so
  // a rename that merely APPENDS to the name still matched. Breaking the sibling weekly-review
  // guard's pin exposed it there (`git fetch` -> `git fetching` passed), and the same hole was here.
  // A pass line is `PASS` + 2 spaces + the case name + 2 spaces + `expected=…`, and some case names
  // themselves end in ` | <command>`, so the name's own end is pinned by requiring one of those two
  // separators immediately after it. That makes a rename of any shape fail, in both name styles.
  const escapeForLine = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const fragment of LOAD_BEARING) {
    assert.ok(
      new RegExp(`^PASS {2}${escapeForLine(fragment)}(?: {2}expected=| \\| )`, "m").test(output),
      `the dev-server reaper selftest no longer runs the case "${fragment}" — matched at the START of a pass ` +
        "line and up to the case name's own end, so this fails whether the case was deleted, renamed, or " +
        "quietly rewritten into something weaker. Each one is a distinct way the hook could come to stop a " +
        "process that is not the ending session's to stop — the owner's server, or another session's, mid-work " +
        "and silently. If a case was deliberately renamed, update this list in the same commit.",
    );
  }
}
