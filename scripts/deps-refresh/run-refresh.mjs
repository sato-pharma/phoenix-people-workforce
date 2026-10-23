// The scheduled launcher for the weekly dependency refresh.
//
//   node scripts/deps-refresh/run-refresh.mjs     (what the Windows task runs — it takes no arguments)
//
// It is the memory fold's launcher (`scripts/module-memory/run-fold.mjs`) with a different job, and
// every reason in that file's header holds here: the task must not name a file inside a working tree,
// so `install-task.ps1` copies THIS file to `~/.claude/scripts/`; it stays on node builtins only so it
// survives an unattended run; it fetches `origin/main`, makes a throwaway worktree there and runs
// `refresh.mjs` from it, so the logic that runs is always what merged; and it writes its own log,
// because the task runs node directly and nobody reads a scheduled job's exit code.
//
// IT NEEDS NO `node_modules` AND NO `.env.local`: `refresh.mjs` imports node builtins and one sibling
// under scripts/lib/, touches no database, and runs pnpm only on GitHub. It needs `git` and `gh`.
//
// For a rehearsal, run `node scripts/deps-refresh/refresh.mjs --dry-run` from a spare checkout instead:
// this launcher deliberately takes no flags, so there is no flag for a typo to miss.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const PRIMARY = process.env.PHX_REFRESH_PRIMARY || "F:/Phoenix Workforce/phoenix-workforce";

// It takes no arguments, and says so rather than ignoring one: a `--dry-run` passed here would otherwise be
// dropped in silence and open a real PR. INLINE, not scripts/lib/refuse-arguments.mjs, because this file is
// copied outside the repo and stays on node builtins only.
const REFRESH_ARGS = process.argv.slice(2);
if (REFRESH_ARGS.length > 0) {
  console.error(`run-refresh: REFUSED — unknown argument ${REFRESH_ARGS.join(" ")}; this launcher takes none and always opens a real PR. To rehearse: node scripts/deps-refresh/refresh.mjs --dry-run`);
  process.exit(2);
}

const LOG = path.join(homedir(), ".claude", "scripts", "deps-refresh-task.log");
const stamp = () => new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
const say = (line) => {
  const text = `[deps-refresh ${stamp()}] ${line}`;
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

// The same bounded retry as run-fold.mjs: another scheduled job or a session fetching into the same
// `.git` in the same second loses this one the ref lock, and that is worth five tries, not a dead week.
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
  say(`the primary checkout is not at ${PRIMARY} — set PHX_REFRESH_PRIMARY`);
  process.exit(1);
}

const tree = path.join(tmpdir(), `phx-deps-refresh-${Date.now()}`);
let added = false;
try {
  fetchMain();
  say(`refreshing from origin/main at ${git(["rev-parse", "--short", "origin/main"])}`);

  git(["worktree", "add", "-q", "--detach", tree, "origin/main"]);
  added = true;

  const refresh = path.join(tree, "scripts", "deps-refresh", "refresh.mjs");
  if (!existsSync(refresh)) throw new Error("origin/main has no scripts/deps-refresh/refresh.mjs — has it been renamed?");

  const out = execFileSync(process.execPath, [refresh], { cwd: tree, encoding: "utf8", maxBuffer: 1 << 24 });
  for (const line of out.split(/\r?\n/).filter(Boolean)) say(line);
  say("done");
} catch (error) {
  say(`FAILED — ${error?.message ?? error}`);
  const details = `${String(error?.stdout ?? "").trim()}\n${String(error?.stderr ?? "").trim()}`.trim();
  if (details) say(details.split(/\r?\n/).slice(-8).join(" | "));
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
  try {
    git(["worktree", "prune"]);
  } catch {
    /* nothing to prune */
  }
}
