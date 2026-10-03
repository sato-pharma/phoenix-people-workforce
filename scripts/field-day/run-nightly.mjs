// The nightly launcher for the Phoenix CRM field day papers.
//
//   node scripts/field-day/run-nightly.mjs [YYYY-MM-DD]
//
// It builds the papers from `origin/main` in a THROWAWAY worktree and removes it again, which is the
// pattern `scripts/module-memory/fold.mjs` already uses for its own scheduled job.
//
// 🔴 WHY NOT SIMPLY RUN THE PRINTER IN THE PRIMARY CHECKOUT. Because the primary is a shared folder
// that nobody pulls: measured 2026-10-03, minutes after the printer merged, it sat **74 commits
// behind `origin/main`** with a live session in it. A nightly task pointed there would have run an
// old copy — or, on the first night, no copy at all — and said nothing. Moving another session's
// working tree forward 74 commits to fix that is not this task's business.
//
// So the launcher owns its own tree: fetch, add a detached worktree at `origin/main`, borrow the
// primary's `node_modules` and `.env.local` (neither is in git), print, remove. The papers still land
// in the PRIMARY's `xlsx/` — `print-day.mjs` resolves that with `--git-common-dir` — so the output
// goes where the owner's documents live and where the hourly backup looks.
//
// It is deliberately tiny and uses node builtins only: `install-task.ps1` copies it to
// `~/.claude/scripts/` so the scheduled task has something stable to invoke, and everything it runs
// afterwards comes fresh from `origin/main`. Keep it that way — logic belongs in the printer, which
// is versioned and tested; this file only has to survive.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRIMARY = process.env.FIELD_DAY_PRIMARY || "F:/Phoenix Workforce/phoenix-workforce";

/**
 * 🔴 THE LAUNCHER WRITES ITS OWN LOG, and the scheduled task runs node DIRECTLY — never
 * `cmd /c node … >> log`. Measured 2026-10-03: with `cmd`, Windows Task Scheduler returned `0x1`
 * immediately and wrote nothing at all, because `cmd /c "A" "B" >> "C"` strips the outer pair of
 * quotes and mangles the path to node. A redirection that silently produces no log is the worst
 * possible failure for a job nobody watches, so there is no shell in the chain any more.
 */
const LOG = path.join(PRIMARY, "xlsx", "field-day-task.log");
const stamp = () => new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
const say = (line) => {
  const text = `[field-day ${stamp()}] ${line}`;
  console.log(text);
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${text}\n`, "utf8");
  } catch {
    /* the console line is still the record */
  }
};

const git = (args, cwd = PRIMARY) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (!existsSync(path.join(PRIMARY, ".git"))) {
  say(`the primary checkout is not at ${PRIMARY} — set FIELD_DAY_PRIMARY`);
  process.exit(1);
}

const tree = path.join(tmpdir(), `phx-field-day-${Date.now()}`);
let added = false;
try {
  git(["fetch", "-q", "origin", "main"]);
  const head = git(["rev-parse", "--short", "origin/main"]);
  say(`building from origin/main at ${head}`);

  git(["worktree", "add", "-q", "--detach", tree, "origin/main"]);
  added = true;

  // Neither of these is in git, and the printer needs both: the Supabase client to read production,
  // and the service role to authenticate. A junction rather than a copy — `node_modules` here is
  // ~10k files and pnpm must never be run in a worktree anyway.
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(tree, "node_modules"), path.join(PRIMARY, "node_modules")], { stdio: "pipe" });
  copyFileSync(path.join(PRIMARY, ".env.local"), path.join(tree, ".env.local"));

  const printer = path.join(tree, "scripts", "field-day", "print-day.mjs");
  if (!existsSync(printer)) throw new Error("origin/main has no scripts/field-day/print-day.mjs — has it been renamed?");

  const day = process.argv[2];
  const out = execFileSync(process.execPath, day ? [printer, day] : [printer], { cwd: tree, encoding: "utf8" });
  for (const line of out.split(/\r?\n/).filter(Boolean)) say(`wrote ${line}`);
  say("done");
} catch (error) {
  // A nightly job that fails silently is worse than no job: the log is the only thing that will ever
  // be read about this run, so the reason goes in it rather than into an exit code nobody sees.
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
