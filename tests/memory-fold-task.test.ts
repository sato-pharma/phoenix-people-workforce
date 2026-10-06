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
