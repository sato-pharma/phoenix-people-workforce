// THE SCHEDULED MEMORY FOLD — the job that makes the documented cadence real.
//
// WHY THIS EXISTS. `AGENTS.md` §2.2 and the owner's standing rules have said since 2026-10-03 that
// the fold runs at 09:00, 15:00 and 21:00 Cairo. Measured 2026-10-06 it was scheduled NOWHERE on
// the laptop: no Windows task, no Claude scheduled task, no workflow cron — the only 21:00 task is
// the CRM field day report, which names `fold.mjs` in a comment and does not run it. So the cadence
// described a job nobody had installed, and every new memory note sat in the `MEMORY.md` inbox,
// re-charging every request in every session, until somebody noticed and ran the fold by hand.
//
// A scheduled job cannot be tested by running it, so what is pinned here is every way the two files
// that constitute it go quietly wrong — each one a failure that produces NO error anywhere:
//   - `cmd /c node … >> log` in the action, which returns 0x1 instantly and writes no log at all
//   - the task naming a file inside a working tree, which runs whatever that shared tree holds
//   - a `-Daily` trigger, which fires on the Sunday the owner excluded
//   - fewer than the three times, or the three times drifting from the documented ones
//   - the launcher growing a dependency, so it needs a `node_modules` the task has not got
//   - the launcher copying `.env.local`, which the fold has no use for
//   - losing `-WakeToRun`/`-StartWhenAvailable`, so a shut lid means no fold and no error
//   - losing `-MultipleInstances IgnoreNew`, so a slow run is overlapped and two folds race for the
//     one fold PR
//   - the launcher swallowing a failure instead of writing the reason to its log
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments, stripHashComments } from "./support/comment-strip.ts";
import { assertFetchRetriesALostLock, LOST_LOCK_2026_10_08 } from "./support/launcher-fetch-retry.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Both files EXPLAIN the mistakes they avoid, quoting them verbatim — `cmd /c "A" "B" >> "C"` and
 * `.env.local` are in the comments precisely so the next reader does not reintroduce them. So every
 * "this must not appear" check below reads a comment-free projection; against the raw text they all
 * fail on their own documentation, which is how a guard ends up being deleted as broken.
 *
 * 🔴 THE PROJECTION COMES FROM `tests/support/comment-strip.ts`, NEVER FROM A LINE-BY-LINE FILTER
 * HERE. `tests/comment-strip-ratchet.test.ts` refuses a test that decides per line whether
 * something is a comment, and it is right to: a line judged by how it STARTS cannot know that a
 * comment is already open, so an open block's continuation lines get scanned as code and a line
 * that mixes code with the comment's start is dropped whole. The first draft of this file did
 * exactly that and the ratchet caught it. `stripHashComments` scans quoting, so `"# not a comment"`
 * survives; `stripComments` handles `//` and block comments. Both blank the span and keep the
 * newlines, so line numbers in any failure still line up with the file.
 */
const INSTALLER = "scripts/module-memory/install-fold-task.ps1";
const LAUNCHER = "scripts/module-memory/run-fold.mjs";

/** The owner's cadence, 2026-10-03: three runs a day, and not on Sundays. */
const TIMES = ["09:00", "15:00", "21:00"];

export function runMemoryFoldTaskTests() {
  const installer = read(INSTALLER);
  const launcher = read(LAUNCHER);
  const installerCode = stripHashComments(installer);
  const launcherCode = stripComments(launcher);

  // The projection has to still contain the commands, or every check below passes vacuously.
  assert.ok(
    /Register-ScheduledTask/.test(installerCode) && /New-ScheduledTaskAction/.test(installerCode),
    "the comment-free installer must still hold its real commands — otherwise the negative checks prove nothing",
  );
  assert.ok(
    /execFileSync/.test(launcherCode) && /worktree/.test(launcherCode),
    "the comment-free launcher must still hold its real commands",
  );

  // ---- the action -------------------------------------------------------------------------------

  // Measured 2026-10-03 on the field-day task: with `cmd` in the chain, Task Scheduler returned
  // 0x1 the instant it fired and wrote nothing, because `cmd /c "A" "B" >> "C"` strips the outer
  // quote pair and mangles the path to node.exe. A job that produces no log is unfixable.
  assert.ok(
    /New-ScheduledTaskAction -Execute \$node\b/.test(installer),
    "the action must execute node DIRECTLY — a cmd wrapper returns 0x1 and writes no log",
  );
  assert.ok(
    !/cmd\s*\/c/i.test(installerCode),
    "no `cmd /c` anywhere in the action: it mangles the path to node.exe and silently writes nothing",
  );
  assert.ok(
    !/>>|Out-File|Start-Transcript/.test(installerCode),
    "no shell redirection — the launcher writes its own log, which is the only record of a run",
  );

  // The primary is shared and nobody pulls it; it sat 23 commits behind origin/main the evening
  // this was written. A task pointed at a working tree runs whatever that tree holds.
  assert.ok(
    /\$launcherDir = Join-Path \(\[Environment\]::GetFolderPath\("UserProfile"\)\) "\\?\.claude\\scripts"/.test(installer),
    "the launcher must be deployed to ~/.claude/scripts, outside every checkout",
  );
  assert.ok(
    /Copy-Item -Path \(Join-Path \$scriptRoot "run-fold\.mjs"\)/.test(installer),
    "the installer must copy run-fold.mjs out of the repo — the task may not name a file in a working tree",
  );
  assert.ok(
    // 🔴 BUILT WITH `new RegExp` OVER A DOUBLE-QUOTED STRING, NOT A REGEX LITERAL, because the
    // pattern needs a BACKTICK (PowerShell escapes its quotes with one) and `comment-strip.ts`
    // does not track regex literals — one backtick there opens a template literal that never
    // closes, and every comment-only guard reading this file below that point goes blind.
    new RegExp("-Argument \"" + String.fromCharCode(96) + "\"\\$launcher" + String.fromCharCode(96) + "\"\"").test(installer),
    "the task must invoke the deployed launcher, not a path inside the repo",
  );

  // ---- the triggers -----------------------------------------------------------------------------

  const defaults = /\[string\[\]\]\$At = @\(([^)]*)\)/.exec(installer);
  assert.ok(defaults, "the installer must declare its default times as a string array");
  const declared = [...defaults![1].matchAll(/"(\d{2}:\d{2})"/g)].map((m) => m[1]);
  assert.deepEqual(
    declared,
    TIMES,
    "the three documented times (09:00, 15:00, 21:00 Cairo) must be the installed defaults, in order",
  );

  assert.ok(
    /New-ScheduledTaskTrigger -Weekly -DaysOfWeek \$weekdays -At \$time/.test(installer),
    "one weekly trigger per time, built from the weekday list",
  );
  assert.ok(
    !/New-ScheduledTaskTrigger -Daily/.test(installerCode),
    "never a -Daily trigger: it fires on the Sunday the owner excluded, and a daily trigger has no except",
  );
  const weekdays = /\$weekdays = @\(([^)]*)\)/.exec(installer);
  assert.ok(weekdays, "the installer must declare the weekday list it builds triggers from");
  const days = [...weekdays![1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    days,
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    "Monday to Saturday — the owner's instruction of 2026-10-03 excludes Sunday",
  );
  assert.ok(!days.includes("Sunday"), "Sunday must never be in the trigger set");

  // ---- the settings that keep a shut lid from being a silent miss ------------------------------

  for (const flag of ["-WakeToRun", "-StartWhenAvailable", "-AllowStartIfOnBatteries", "-DontStopIfGoingOnBatteries"]) {
    assert.ok(
      installer.includes(flag),
      `${flag} must stay: without wake and catch-up a closed lid means no fold and no error`,
    );
  }
  assert.ok(
    /-MultipleInstances IgnoreNew/.test(installer),
    "IgnoreNew must stay: two folds at once would both try to open the single fold PR",
  );

  // ---- the launcher -----------------------------------------------------------------------------

  // It is copied outside the repo, so anything it imports has to be there too. node builtins only.
  const imports = [...launcher.matchAll(/^import .*?from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "the launcher must import something — otherwise this check proves nothing");
  for (const spec of imports) {
    assert.ok(
      spec.startsWith("node:"),
      `the launcher may import node builtins only (found "${spec}") — it runs with no node_modules`,
    );
  }

  // The fold touches no database. The field-day launcher copies `.env.local` because its printer
  // reads production; this one must not, so no secret is written outside the checkout.
  assert.ok(
    !/\.env\.local/.test(launcherCode),
    "the launcher must not copy .env.local — the fold reads no database and needs no secret",
  );
  assert.ok(
    !/mklink/.test(launcherCode),
    "no node_modules junction: the fold and everything it runs are node builtins, so there is nothing to link",
  );

  // Running a STALE fold is the failure the worktree exists to prevent.
  assert.ok(
    /git\(\["fetch", "-q", "origin", "main"\]\)/.test(launcher),
    "the launcher must fetch origin/main before reading it",
  );
  assert.ok(
    /git\(\["worktree", "add", "-q", "--detach", tree, "origin\/main"\]\)/.test(launcher),
    "the launcher must run the fold from a throwaway worktree at origin/main, never from a checkout",
  );
  assert.ok(
    /scripts", "module-memory", "fold\.mjs"/.test(launcher) && /--apply/.test(launcher),
    "the launcher must run origin/main's own fold.mjs with --apply",
  );
  assert.ok(
    /has no scripts\/module-memory\/fold\.mjs/.test(launcher),
    "a renamed fold must be reported, not skipped silently",
  );

  // The log is the only thing anybody will read about a 09:00 run.
  assert.ok(
    /appendFileSync\(LOG/.test(launcher),
    "the launcher must write its own log — there is no shell in the chain to redirect one",
  );
  assert.ok(
    new RegExp("say\\(" + String.fromCharCode(96) + "FAILED — ").test(launcher),
    "a failure must land in the log with its reason, not only in an exit code nobody reads",
  );
  assert.ok(
    /timeZone: "Africa\/Cairo"/.test(launcher),
    "log lines carry Cairo local time (the owner's standing rule), never raw UTC",
  );
  assert.ok(
    /homedir\(\), "\.claude", "scripts", "memory-fold-task\.log"/.test(launcher),
    "the log lives beside the machine's other job logs, not in the repo and not in xlsx/",
  );

  // The folder must always be cleared: `git worktree remove` leaves a registration behind when the
  // folder went first, which `repo:doctor` then reports as a husk forever.
  assert.ok(
    /\["worktree", "prune"\]/.test(launcher),
    "the launcher must prune after removing its worktree, or it leaves a husk three times a day",
  );

  // 🔴 Measured 2026-10-08 21:00 Cairo: this launcher and the field day's both fetched origin/main into
  // the same `.git` in the same second, and the loser died on the lock. The fetch must retry a lost
  // lock — boundedly — and the run must go through that retry, not around it.
  assertFetchRetriesALostLock(launcherCode, LAUNCHER);

  // ---- the installer's own remove path ----------------------------------------------------------

  assert.ok(
    /Unregister-ScheduledTask -TaskName \$TaskName -Confirm:\$false/.test(installer),
    "-Remove must actually unregister the task without prompting",
  );
  const taskName = /\$TaskName = "([^"]+)"/.exec(installer);
  assert.ok(taskName, "the installer must name the task in one place");
  assert.equal(
    taskName![1],
    "Phoenix memory fold",
    "the task name is what a session greps for when asking whether the fold is installed",
  );
}

/**
 * 🔴 A NETWORK BLIP MUST NOT COST A WHOLE FOLD. The 15:00 run on 2026-10-08 died at 15:04 Cairo on
 * one "Connection was reset" during `git push`, with no retry, and its notes waited six hours. The
 * push and the PR create now retry a transient network failure three times (5 s / 15 s / 45 s), and
 * nothing else; a branch that was pushed but got no PR is deleted, unless the PR was in fact made.
 */
export async function runMemoryFoldRetryTests() {
  const { withRetry, TRANSIENT, FETCH_RETRYABLE, RETRY_DELAYS_MS } = await import("../scripts/module-memory/fold.mjs");
  const fail = (stderr: string) => Object.assign(new Error("Command failed: git push"), { stderr });
  const quiet = { log: () => {}, sleep: async () => {} };

  for (const text of [
    "fatal: unable to access 'https://github.com/x/y.git/': Recv failure: Connection was reset",
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502",
    "Operation timed out after 30000 milliseconds",
  ]) assert.ok(TRANSIENT.test(text), `a transient network failure must be retried: ${text}`);
  for (const text of ["! [rejected] main -> main (non-fast-forward)", "a pull request for branch x already exists", "HTTP 404"]) {
    assert.ok(!TRANSIENT.test(text), `a real failure must throw at once, never be retried: ${text}`);
  }
  assert.deepEqual(RETRY_DELAYS_MS, [5000, 15000, 45000]);

  let calls = 0;
  const waits: number[] = [];
  const got = await withRetry("git push", () => {
    calls += 1;
    if (calls < 3) throw fail("fatal: unable to access 'https://github.com/x': Connection was reset");
    return "pushed";
  }, { log: () => {}, sleep: async (ms: number) => { waits.push(ms); } });
  assert.equal(got, "pushed", "a push that succeeds on its third attempt succeeds");
  assert.deepEqual(waits, [5000, 15000], "it waits 5 s, then 15 s, between attempts");

  calls = 0;
  await assert.rejects(
    withRetry("git push", () => { calls += 1; throw fail("Connection was reset"); }, quiet),
    /Command failed/,
    "after three transient failures the error is thrown, not swallowed",
  );
  assert.equal(calls, 3, "three attempts, no more");

  calls = 0;
  await assert.rejects(withRetry("git push", () => { calls += 1; throw fail("! [rejected] (non-fast-forward)"); }, quiet));
  assert.equal(calls, 1, "a non-network failure is not retried");

  // 🔴 The fold's own fetch races the field day's at 21:00 (2026-10-08). A lost lock is retried on the
  // FETCH; on a push it means the remote moved, which no retry fixes, so the push stays network-only.
  assert.ok(FETCH_RETRYABLE instanceof RegExp, "fold.mjs must export FETCH_RETRYABLE, the fetch's lock-aware retry pattern");
  assert.ok(FETCH_RETRYABLE.test(LOST_LOCK_2026_10_08), "a fetch that lost the ref lock must be retried");
  assert.ok(!TRANSIENT.test(LOST_LOCK_2026_10_08), "the push's network-only pattern must not start retrying lock errors");
  assert.ok(FETCH_RETRYABLE.test("fatal: unable to access 'https://github.com/x': Connection was reset"), "the fetch keeps every network retry too");
  calls = 0;
  const fetched = await withRetry("git fetch", () => {
    calls += 1;
    if (calls < 2) throw Object.assign(new Error(`Command failed: git fetch -q origin main\n${LOST_LOCK_2026_10_08}`), { stderr: LOST_LOCK_2026_10_08 });
    return "";
  }, { ...quiet, retryOn: FETCH_RETRYABLE });
  assert.equal(fetched, "", "a fetch that lost the lock once succeeds on its second attempt");
  assert.equal(calls, 2);

  const fold = stripComments(read("scripts/module-memory/fold.mjs"));
  assert.ok(/withRetry\("git fetch", \(\) => git\(\["fetch", "-q", "origin", "main"\]\), \{ retryOn: FETCH_RETRYABLE \}\)/.test(fold),
    "the fold's fetch must go through the retry, with the lock-aware pattern");
  assert.equal([...fold.matchAll(/git\(\["fetch"/g)].length, 1, "and there is no second, unguarded fetch");
  assert.ok(/withRetry\("git push"/.test(fold) && /withRetry\("gh pr create"/.test(fold),
    "both the push and the PR create must go through the retry");
  assert.ok(/"pr", "list", "--head", branch/.test(fold),
    "a failed create must first ask whether the PR was made anyway, or a live PR loses its branch");
  assert.ok(/"push", "-q", "origin", "--delete", branch/.test(fold),
    "a pushed branch that got no PR must be deleted, or the next run stacks a second branch beside it");
}
