// The guard that holds an UNATTENDED run to read-only must itself be tested.
//
// WHY THIS EXISTS. `weekly-review-readonly.mjs` is a **global** PreToolUse hook — it lives in
// `~/.claude/hooks/`, not in this repository — so nothing anywhere could go red when it weakened. It
// is the sixth global hook to be pinned, and the only one of the six that guards a run with **nobody
// watching**. The other five answer to a session that can notice them; this one answers to a
// scheduled task at 2am.
//
// 🔴 IT EXISTS BECAUSE THE RULE ALONE DID NOT HOLD. The weekly config review's own skill says, in
// capitals, "READ-ONLY. Change nothing in this run: no edits, no moves, no deletes, no git writes
// (no fetch, commit, push or checkout), no settings changes." On 2026-09-21, between 01:41 and 02:21
// Cairo, the automated run rewrote `xlsx-snapshot.cmd` and exported and **re-registered** the hourly
// snapshot scheduled task anyway. An instruction in prose did not stop it; this hook is the version
// that does. A regression here restores the state where a 2am run can rewrite the machine's own
// backup plumbing — and there is no session present to see it happen.
//
// WHAT HAD TO CHANGE TO WIRE IT. Its suite printed `all checks passed`. `claude-scripts-backup.mjs`
// accepts a hook as healthy only on exit 0 **and** a line matching `0 failed`, so adding the hourly
// entry without touching the hook would have reported this perfectly good guard as BROKEN every
// hour. The summary line is now `N cases, N failed`, like the other five — the fix went into the
// hook rather than into a sixth spelling in the runner, because one shape across every hook is what
// makes a single `0 failed` test worth trusting. That is why the summary wording is asserted below:
// rewording it silently breaks the hourly half while CI stays green.
//
// WHAT IS ASSERTED. The same three layers as `tests/verify-shipped-selftest.test.ts`,
// `tests/next-step-guard-decisions.test.ts`, `tests/risky-allow-guard-pin.test.ts`,
// `tests/memory-guard-pin.test.ts` and `tests/dev-server-reaper-pin.test.ts`:
//   1. the selftest runs and reports 0 failed;
//   2. the case COUNT never falls — which layer 1 cannot see, because a deleted case still exits 0
//      with `0 failed`;
//   3. the load-bearing cases are present BY NAME — which neither of the others can see, because a
//      hard case swapped for an easy one keeps both the count and the exit code intact.
// Plus three this hook needs: the printed total must equal the `ok` lines it printed, the mode must
// still be the exact flag `--selftest`, and the summary must still say `cases, … failed`.
//
// SAFE TO RUN IN CI. The suite calls the hook's pure predicates only — it starts no process, reads
// no transcript and writes no log — and the subprocess is pointed at a temp HOME regardless.
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
const HOOK = join(REPO_ROOT, ".claude", "cloud-context", "laptop-hooks", "weekly-review-readonly.mjs");

// A ratchet, not an equality: cases may RISE and must never FALL. 45 as of 2026-10-06, counted by the
// suite itself at runtime rather than written here, which is how the figure in this comment can never
// be the thing CI trusts.
const MIN_CASES = 45;

// Three groups, each a distinct way this guard fails: it stops firing at all, it lets through exactly
// what the 2026-09-21 run did, or it starts blocking the reads the review legitimately needs (which
// would get it switched off, and that is the same outcome by a slower route).
const LOAD_BEARING = [
  "detects the scheduled run", // without this the guard never fires and everything below is moot
  "ignores a human session", // it must not gate ordinary sessions, or it gets turned off
  "ignores a session DISCUSSING the review", // the marker appearing in prose is not the run
  "Register-ScheduledTask", // what the 2026-09-21 run actually did to the hourly snapshot task
  "node -e rewriting a file", // ditto — a write smuggled inside a read-shaped command
  "cp over a script", // ditto — it overwrote xlsx-snapshot.cmd
  "redirect to a file", // the cheapest bypass of a verb allow-list
  "good verb, bad second segment", // `cat a.txt && rm -rf b` — a chain is only as safe as its worst link
  "command substitution", // a write hidden where the allow-list never looks
  "git fetch", // the skill forbids git writes INCLUDING fetch, which reads as harmless
  "mcp update_scheduled_task", // the MCP route straight around every Bash check above
  "2>/dev/null tolerated", // a legitimate read must still pass, or the guard is unusable
];

export function runWeeklyReviewReadonlyPinTests() {
  assert.ok(
    existsSync(HOOK),
    `the pinned copy of weekly-review-readonly.mjs must exist at ${HOOK}. ` +
      "It is produced by `node scripts/sync-cloud-context.mjs` (PINNED_HOOKS) — if that stopped mirroring it, " +
      "fix the sync rather than deleting this test, because a missing copy is how CI comes to test nothing.",
  );

  const source = readFileSync(HOOK, "utf8");

  assert.ok(
    source.includes("process.argv.includes('--selftest')"),
    "the pinned copy must still dispatch on the exact flag `--selftest`. The hourly HOOK_SELFTESTS entry in " +
      "claude-scripts-backup.mjs passes exactly that, and a renamed mode makes the hourly run exercise nothing — " +
      "silently, exiting 0, which reads as `this file has no selftest`. Three of the six global hooks take the " +
      "BARE word instead, so the spelling is never safe to assume.",
  );

  assert.ok(
    source.includes("cases, ${bad} failed"),
    "the pinned copy's summary line must still report `<n> cases, <n> failed`. That wording is a CONTRACT, not " +
      "prose: `runHookSelftests` in claude-scripts-backup.mjs accepts a hook only on exit 0 AND a line matching " +
      "`0 failed`. This hook printed `all checks passed` until 2026-10-06, which that function reads as BROKEN — " +
      "so rewording this line silently breaks the hourly half of the cover while CI here stays green.",
  );

  assert.ok(
    source.includes("function isReadOnlyCommand(") &&
      source.includes("function isReadOnlyMcpTool(") &&
      source.includes("function isWeeklyReviewFirstLine("),
    "the pinned copy must still expose all three predicates: `isWeeklyReviewFirstLine` (is this the scheduled " +
      "run at all), `isReadOnlyCommand` (shell) and `isReadOnlyMcpTool` (the route around the shell). Losing the " +
      "MCP one leaves the Bash checks looking complete while `update_scheduled_task` walks straight past them — " +
      "which is the shape of the 2026-09-21 incident.",
  );

  // A temp HOME so the hook's log path and any state it reaches for land in a sandbox. The selftest
  // path touches neither today; this keeps that true for whoever adds the next case.
  const sandbox = mkdtempSync(join(tmpdir(), "phx-weekly-pin-"));

  const run = spawnSync(process.execPath, [HOOK, "--selftest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, GH_TOKEN: "", GITHUB_TOKEN: "" },
    input: "",
    timeout: 120_000,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;

  assert.equal(
    run.status,
    0,
    `weekly-review-readonly.mjs --selftest must exit 0. It exits 1 when any case fails, so a non-zero status ` +
      `here is a real regression and not a harness problem.\nexit=${run.status}\n${output}`,
  );

  const summary = /SELFTEST weekly-review-readonly: (\d+) cases, (\d+) failed/.exec(output);
  assert.ok(
    summary,
    `the selftest must print its own summary line so this test can read the counts; got:\n${output}`,
  );

  const cases = Number(summary[1]);
  const failed = Number(summary[2]);

  assert.equal(failed, 0, `the weekly-review guard selftest reported ${failed} failed case(s):\n${output}`);

  assert.ok(
    cases >= MIN_CASES,
    `the weekly-review guard selftest has ${cases} cases and must never drop below ${MIN_CASES}. ` +
      "Cases were deleted, not fixed — a deleted case still exits 0 and still prints `0 failed`, which is " +
      "exactly what this ratchet exists to catch. If cases were genuinely consolidated, lower MIN_CASES in " +
      "the same commit and say why in the message.",
  );

  const okLines = (output.match(/^ok {4}/gm) || []).length;
  assert.equal(
    okLines,
    cases,
    `the selftest printed ${cases} in its summary but ${okLines} ok lines, with 0 failed. The suite counts its ` +
      "own cases at runtime so those two cannot disagree — a mismatch means the counter stopped being " +
      "incremented per case, which would let cases be deleted without the ratchet above noticing.",
  );

  // 🔴 MATCHED AS THE WHOLE PRINTED LINE, not as a substring of the output. A free-floating
  // `output.includes("git fetch")` was the first version of this loop, and breaking it exposed the
  // hole: renaming that case to `git fetching` still CONTAINS the fragment, so the rename passed
  // unnoticed — the exact failure the by-name layer exists to catch. A success line is exactly
  // `ok` + four spaces + the case name, so the full name can be pinned, and a rename of any shape
  // now fails. (`escapeForLine` is needed because real case names here hold `>`, `-` and `/`.)
  const escapeForLine = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const name of LOAD_BEARING) {
    assert.ok(
      new RegExp(`^ok {4}${escapeForLine(name)}\\s*$`, "m").test(output),
      `the weekly-review guard selftest no longer runs the case "${name}" — matched as the COMPLETE ok line, ` +
        "so this fails whether the case was deleted, renamed, or quietly rewritten into something weaker. Each " +
        "one is either a write the 2026-09-21 unattended run actually performed, a bypass of the verb " +
        "allow-list, or a legitimate read that must keep passing — and nobody is watching when this guard is " +
        "wrong. If a case was deliberately renamed, update this list in the same commit.",
    );
  }
}
