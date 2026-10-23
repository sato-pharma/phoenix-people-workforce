// The scheduled launcher for the nightly cloud-mirror refresh.
//
//   node scripts/cloud-mirror/run-refresh.mjs     (what the Windows task runs — it takes no arguments)
//
// It is the weekly dependency refresh's launcher (`scripts/deps-refresh/run-refresh.mjs`) with a
// different job, and every reason in that file's header holds here: the task must not name a file
// inside a working tree, so `install-task.ps1` copies THIS file to `~/.claude/scripts/`; it stays on
// node builtins only so it survives an unattended run; it fetches `origin/main`, makes a throwaway
// worktree there and runs `refresh.mjs` from it, so the logic that runs is always what merged; and it
// writes its own log, because the task runs node directly and nobody reads a scheduled job's exit code.
//
// IT NEEDS NO `node_modules` AND NO `.env.local`: `refresh.mjs`, `sync-cloud-context.mjs` and
// `module-memory/build.mjs` import node builtins and each other, and touch no database. It needs `git`,
// `gh`, and the laptop's own `~/.claude/projects/<slug>/memory/` — which is the whole reason this runs
// here and not on a GitHub runner.
//
// 🔴 THE THROWAWAY WORKTREE IS NOT A PROBLEM FOR THE SOURCE. `sync-cloud-context.mjs` names the memory
// directory with a CONSTANT slug and resolves it under `os.homedir()`, so it reads the laptop's live
// memory wherever the checkout sits; what moves is the mirror inside this worktree, which is exactly
// the diff `main` needs.
//
// For a rehearsal, run `node scripts/cloud-mirror/refresh.mjs --dry-run` from a spare checkout instead:
// this launcher deliberately takes no flags, so there is no flag for a typo to miss.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const PRIMARY = process.env.PHX_REFRESH_PRIMARY || "F:/Phoenix Workforce/phoenix-workforce";

// It takes no arguments, and says so rather than ignoring one: a `--dry-run` passed here would otherwise
// be dropped in silence and push for real. INLINE, not scripts/lib/refuse-arguments.mjs, because this
// file is copied outside the repo and stays on node builtins only.
const EXTRA_ARGS = process.argv.slice(2);
if (EXTRA_ARGS.length > 0) {
  console.error(`run-refresh: REFUSED — unknown argument ${EXTRA_ARGS.join(" ")}; this launcher takes none and always pushes for real. To rehearse: node scripts/cloud-mirror/refresh.mjs --dry-run`);
  process.exit(2);
}

const LOG = path.join(homedir(), ".claude", "scripts", "cloud-mirror-task.log");
const stamp = () => new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
const say = (line) => {
  const text = `[cloud-mirror ${stamp()}] ${line}`;
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

// The same bounded retry as run-fold.mjs and the dependency refresh's launcher: another scheduled job or
// a session fetching into the same `.git` in the same second loses this one the ref lock, and that is
// worth five tries, not a dead night.
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

const tree = path.join(tmpdir(), `phx-cloud-mirror-${Date.now()}`);
let added = false;
try {
  fetchMain();
  say(`refreshing from origin/main at ${git(["rev-parse", "--short", "origin/main"])}`);

  git(["worktree", "add", "-q", "--detach", tree, "origin/main"]);
  added = true;

  // 🔴 NOT A FAILURE, AND NOT A SILENT SKIP EITHER. The task is installed the day the job is written,
  // because a cadence that lives only in a doc is a description and not an installed job — but the
  // launcher runs `origin/main`'s copy, which does not exist until the PR carrying it MERGES. So the
  // nights in between say so in the log, by name, and exit 0; the same line after the merge means the
  // script was renamed or removed, which is why it names the path rather than shrugging.
  const refresh = path.join(tree, "scripts", "cloud-mirror", "refresh.mjs");
  if (existsSync(refresh)) {
    const out = execFileSync(process.execPath, [refresh], { cwd: tree, encoding: "utf8", maxBuffer: 1 << 24 });
    for (const line of out.split(/\r?\n/).filter(Boolean)) say(line);
    say("done");
  } else {
    // It exits 0 through the same cleanup as any other night — never process.exit here, which would
    // skip the finally below and leave the throwaway worktree registered until someone pruned it.
    say("WAITING — origin/main has no scripts/cloud-mirror/refresh.mjs; the PR carrying it has not merged (or it was renamed). Nothing run, nothing pushed");
  }
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
