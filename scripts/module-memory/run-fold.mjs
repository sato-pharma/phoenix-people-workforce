// The scheduled launcher for the memory fold.
//
//   node scripts/module-memory/run-fold.mjs            file the inbox and open the PR
//   node scripts/module-memory/run-fold.mjs --dry-run   print what the fold would file, write nothing
//
// 🔴 WHY THIS FILE EXISTS AT ALL. `AGENTS.md` §2.2 and the owner's standing rules have said since
// 2026-10-03 that the fold runs three times a day at 09:00, 15:00 and 21:00 Cairo. Measured
// 2026-10-06, it was scheduled NOWHERE on this machine — no Windows task, no Claude scheduled task,
// no workflow cron; the only 21:00 task is the CRM field day report, which mentions `fold.mjs` in a
// comment and does not run it. So every note written since then sat in the `MEMORY.md` inbox,
// re-charging every request, until a session happened to run the fold by hand. A documented cadence
// is not an installed job, and nothing was going to say so.
//
// 🔴 THE TASK MUST NOT NAME A FILE IN A WORKING TREE. The primary checkout is a shared folder
// nobody pulls — it sat 23 commits behind `origin/main` on the evening this was written — so a task
// pointed there runs whatever that tree happens to hold and reports to no one. `install-fold-task.ps1`
// copies THIS file to `~/.claude/scripts/`, outside every checkout, and everything it runs afterwards
// comes fresh from `origin/main`. Keep it tiny and on node builtins only: the logic belongs in
// `fold.mjs`, which is versioned and tested, and this file only has to survive.
//
// WHY A WORKTREE WHEN `fold.mjs` ALREADY MAKES ONE. Because the thing that must be current is
// `fold.mjs` ITSELF, and the only way to be sure of that is to run the copy on `origin/main`. It
// fetches and makes its own worktree for the commit it pushes, which is a second `worktree add` per
// run — the cost of never running a stale fold, three times a day.
//
// IT NEEDS NO `node_modules` AND NO `.env.local`. `fold.mjs`, `build.mjs` and
// `sync-cloud-context.mjs` import node builtins and their own siblings, nothing else, and the fold
// touches no database — so this launcher copies no secret anywhere, unlike the field-day one.
// It does need `git` and `gh` on PATH: the fold pushes a branch and opens the PR itself.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const PRIMARY = process.env.PHX_FOLD_PRIMARY || "F:/Phoenix Workforce/phoenix-workforce";
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * 🔴 THE LAUNCHER WRITES ITS OWN LOG, AND THE TASK RUNS NODE DIRECTLY — never
 * `cmd /c node … >> log`. Measured 2026-10-03 on the field-day task: with `cmd` in the chain
 * Windows Task Scheduler returned `0x1` the instant it fired and wrote nothing at all, because
 * `cmd /c "A" "B" >> "C"` strips the outer pair of quotes and mangles the path to node.exe. For a
 * job nobody watches, a redirection that silently produces no log is the worst failure there is.
 *
 * The log sits beside the machine's other job logs in `~/.claude/scripts/`, not in the repo and not
 * in `xlsx/`: it is machine bookkeeping, it must survive a worktree being retired, and the hourly
 * xlsx backup has no business carrying it.
 */
const LOG = path.join(homedir(), ".claude", "scripts", "memory-fold-task.log");
const stamp = () => new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
const say = (line) => {
  const text = `[memory-fold ${stamp()}] ${line}`;
  console.log(text);
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${text}\n`, "utf8");
  } catch {
    /* the console line is still the record */
  }
};

const git = (args, cwd = PRIMARY) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();

/**
 * 🔴 A FETCH THAT LOSES A LOCK IS RETRIED, NOT FATAL. Measured 2026-10-08 21:00 Cairo: this launcher
 * and the CRM field day's `run-nightly.mjs` — both scheduled at 21:00 — fetched `origin/main` into
 * the same `.git` in the same second, and the loser died on `cannot lock ref
 * 'refs/remotes/origin/main': is at … but expected …` (that night it was the field day, so no papers).
 * The other git process is done in seconds, so a lost lock (or a network blip) is retried up to five
 * attempts, 5 s / 10 s / 15 s / 20 s apart; any other failure throws at once, as before. Moving 21:00
 * instead would only move the race: every session in the shared primary fetches too.
 */
const RETRYABLE = /cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'|Connection was reset|Could not resolve host|Operation timed out|HTTP 5\d\d|unable to access/i;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fetchMain = () => {
  for (let attempt = 1; ; attempt++) {
    try {
      return git(["fetch", "-q", "origin", "main"]);
    } catch (error) {
      if (attempt >= 5 || !RETRYABLE.test(`${error?.message ?? ""}\n${error?.stderr ?? ""}`)) throw error;
      say(`fetch attempt ${attempt} of 5 lost a lock or the network — retrying in ${attempt * 5} s`);
      pause(attempt * 5000);
    }
  }
};

if (!existsSync(path.join(PRIMARY, ".git"))) {
  say(`the primary checkout is not at ${PRIMARY} — set PHX_FOLD_PRIMARY`);
  process.exit(1);
}

const tree = path.join(tmpdir(), `phx-memory-fold-${Date.now()}`);
let added = false;
try {
  fetchMain();
  const head = git(["rev-parse", "--short", "origin/main"]);
  say(`folding from origin/main at ${head}${DRY_RUN ? " (dry run)" : ""}`);

  git(["worktree", "add", "-q", "--detach", tree, "origin/main"]);
  added = true;

  const fold = path.join(tree, "scripts", "module-memory", "fold.mjs");
  if (!existsSync(fold)) throw new Error("origin/main has no scripts/module-memory/fold.mjs — has it been renamed?");

  const out = execFileSync(process.execPath, DRY_RUN ? [fold] : [fold, "--apply"], { cwd: tree, encoding: "utf8" });
  for (const line of out.split(/\r?\n/).filter(Boolean)) say(line);
  say("done");
} catch (error) {
  // A scheduled job that fails silently is worse than no job: this log is the only thing anybody
  // will ever read about a 09:00 run, so the reason goes in it rather than into an exit code.
  say(`FAILED — ${error?.message ?? error}`);
  const details = String(error?.stderr ?? "").trim();
  if (details) say(details.split(/\r?\n/).slice(0, 5).join(" | "));
  process.exitCode = 1;
} finally {
  if (added) {
    try {
      git(["worktree", "remove", "--force", tree]);
    } catch {
      say(`could not remove ${tree} — remove it with git worktree remove`);
    }
  }
  try {
    if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
  } catch {
    say(`a husk remains at ${tree}`);
  }
  // `git worktree remove` leaves the registration behind when the folder went first.
  try {
    git(["worktree", "prune"]);
  } catch {
    /* nothing to prune */
  }
}
