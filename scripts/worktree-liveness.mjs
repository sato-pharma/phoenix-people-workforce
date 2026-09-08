// Is a session ALIVE in this worktree right now?
//
// WHY THIS IS ITS OWN FILE. `scripts/repo-doctor.mjs` prints, for every worktree it calls
// retirable, a copy-paste block ending in `git worktree remove` and `git branch -D`. Its gates
// answer three questions — are there uncommitted files, are there commits found nowhere upstream,
// is the newest PR merged with HEAD unmoved — and every one of them is a question about the
// CONTENT of the folder. None of them asks whether somebody is USING it. AGENTS.md section 2.1
// states the consequence plainly: "Every retirement gate can PASS on a worktree in active use —
// nothing catches a live PROCESS."
//
// HIT LIVE 2026-09-08, TWICE IN ONE MOMENT. repo-doctor listed both
// `.claude/worktrees/zen-tu-c5980b` and `.claude/worktrees/zealous-dewdney-7afb5e` as RETIRABLE
// while an interactive Claude session sat in each. Something ran the commands as printed. Both
// folders became empty deregistered husks under the running sessions, which is the worst of the
// failure shapes rather than the mildest:
//
//   - the folder still exists, so `pwd` keeps answering with it and looks entirely normal;
//   - `git rev-parse --show-toplevel` silently resolves to the PRIMARY checkout instead, and the
//     primary usually sits on `main`, so the next bare `git commit` in that shell lands on
//     PRODUCTION's branch with no error;
//   - `cd` cannot escape it, because the shell resets its cwd back inside after every command.
//
// Neither session lost work, and that was luck rather than design: both happened to have merged
// and pushed minutes earlier. A session mid-edit would have lost whatever was uncommitted, and
// `.gitignore` matches `*.xlsx`, so a working spreadsheet in there exists in no commit anywhere.
//
// WHAT ACTUALLY SEES A LIVE SESSION. Windows exposes no process's working directory through any
// built-in tool, which is exactly why this reads as unanswerable and why the gates never asked.
// `scripts/find-worktree-holder.ps1` already solves it by reading each process's PEB directly;
// this module is the decision built on top of that, kept apart from the reporting so a test can
// drive it without a live machine — the same split, for the same reason, as
// `scripts/branch-pr-state.mjs`.
//
// THE CASE THAT ARGUES FOR THIS SIGNAL BEST IS NOT THE IDLE ONE. Measured 2026-09-08, hours after
// the incident: `_wt-repo-doctor-live-sessions` was pinned by a background `gh pr checks --watch`
// whose cwd sat inside it — pids 22784 `bash`, 28404 `gh`, 1948 and 5612 `timeout`. NO session was
// ever opened in that folder and NO transcript for it exists, so the transcript signal returns null
// and would have offered it for removal. That is a blind spot rather than a threshold, which makes
// it a stronger argument than "a session idle past the window". `git worktree remove` then failed
// Permission denied, deregistered the worktree anyway, and left the husk.
//
// The same case is this signal's FALSE-POSITIVE class, and the direction is the safe one: a stray
// process refuses a deletion rather than causing one. But somebody will eventually meet a folder
// that will not retire and go looking for a session to close that does not exist, so the report
// names the holding PIDs and says the holder may be a stray process. Stopping a background TASK is
// not enough either — it kills the wrapper shell and leaves the child holding the folder, the shape
// AGENTS.md 5 records for dev servers. Kill the named PIDs, never machine-wide.
//
// WHAT THIS DOES NOT COVER, stated because a guard read as total is worse than a known gap.
// It sees a session's own process only for `.claude/worktrees/*`. An `_wt-*` session's cwd is the
// PRIMARY checkout (AGENTS.md 2.1), so no row of the sweep names its folder. Measured here on
// 2026-09-08: every `claude` process reported a `.claude/worktrees/` path and not one reported an
// `_wt-*` folder; the only `_wt-*` holders were transient `bash`/`node`/`sleep` children, in 2 of
// the ~10 such folders on the machine, present only while a command ran. That is precisely not the
// moment the folder is idle and at risk. This narrows the IDLE gap next to the transcript signal;
// it does not narrow the `_wt-*` one, and the report says so on screen.
//
// THE DANGEROUS DIRECTION IS ONE-WAY, so every unknown answers "live". A probe that cannot run, or
// that runs and reads zero processes, must never be reported as "the folder is free" — see
// {@link livenessVerdict}, where that is the whole point of the first two rules.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Minutes of build-cache silence below which a worktree is presumed to have a live dev server. */
export const CACHE_ACTIVITY_WINDOW_MIN = 120;

/**
 * One comparable spelling of a Windows path.
 *
 * Three things differ between what the PEB hands back and what git reports, and all three defeat a
 * plain `startsWith`: the PEB's directory carries a TRAILING separator (`...\zen-tu-c5980b\`), it
 * uses backslashes where git uses forward slashes, and Windows paths are case-insensitive while
 * JavaScript string comparison is not.
 */
export function normalizeHolderPath(p) {
  if (typeof p !== "string") return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Parse `find-worktree-holder.ps1 -Json`. Returns null for anything unparseable — a caller must
 * treat that as "could not tell", never as "nothing found".
 */
export function parseHolderProbe(stdout) {
  if (typeof stdout !== "string") return null;
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const readable = Number(parsed.readable);
  if (!Number.isFinite(readable) || readable < 0) return null;
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  return {
    readable,
    rows: rows
      .map((r) => ({
        pid: Number(r?.Pid ?? r?.pid),
        name: String(r?.Name ?? r?.name ?? "").trim() || "unknown",
        cwd: normalizeHolderPath(r?.Cwd ?? r?.cwd),
      }))
      .filter((r) => Number.isFinite(r.pid) && r.cwd),
  };
}

/**
 * Holders whose working directory is AT or BENEATH `dir`.
 *
 * The boundary matters: a bare prefix test makes `_wt-pharmacy` match `_wt-pharmacy-guard`, and
 * this repo names worktrees by extending a shared stem constantly, so that is not hypothetical.
 */
export function holdersInside(dir, rows) {
  const base = normalizeHolderPath(dir);
  if (!base) return [];
  return (rows ?? []).filter((r) => r.cwd === base || r.cwd.startsWith(`${base}/`));
}

/**
 * Is this worktree in use? `{ live, reason }`, where `live` keeps it out of the retirable listing.
 *
 * Rule order is the safety property, not a style choice. The two "cannot tell" rules come FIRST
 * and answer `live`, so a broken probe holds every worktree back rather than clearing them all at
 * once. `readable === 0` earns its own rule: an empty row list is the same JSON whether nobody is
 * in a worktree or the sweep failed outright, and only the process count separates those.
 */
export function livenessVerdict({
  dir,
  probe,
  cacheIdleMin = null,
  sourceIdleMin = null,
  windowMin = CACHE_ACTIVITY_WINDOW_MIN,
}) {
  if (!probe) {
    return { live: true, reason: "cannot run the process sweep, so a live session cannot be ruled out" };
  }
  if (probe.readable === 0) {
    return {
      live: true,
      reason: "the process sweep read 0 processes — it is broken, not empty, so nothing is proven free",
    };
  }
  const holders = holdersInside(dir, probe.rows);
  if (holders.length) {
    const who = holders.map((h) => `${h.name} pid ${h.pid}`).join(", ");
    return { live: true, reason: `a live process is sitting in it (${who})` };
  }
  if (cacheIdleMin !== null && cacheIdleMin < windowMin) {
    return {
      live: true,
      reason: `its build cache was written ${cacheIdleMin} min ago — a dev server may be running`,
    };
  }
  // THE INVARIANT THIS LAST RULE EXISTS FOR: nothing --strip-idle refuses as possibly-mid-edit may
  // be offered for DELETION by the same run. repo-doctor already measured source idleness for the
  // strip pass and simply never showed it to the retirable pass, so one half of a single report
  // could refuse to drop a worktree's node_modules while the other half printed
  // `git worktree remove` for the whole folder. That contradiction is not hypothetical — it is the
  // 2026-08-12 shape recorded in the RETIRABLE block, and it appeared again on 2026-09-08 with
  // `_wt-code-strand-guard`, which the strip pass called "touched 18 min ago — a session may be
  // mid-edit" in the very run whose retirable gate had cleared it.
  //
  // Deliberately LAST: a holder read out of the PEB is direct evidence, while an mtime is an
  // inference, so the specific reason is the one a reader gets when both would fire.
  if (sourceIdleMin !== null && sourceIdleMin < windowMin) {
    return {
      live: true,
      reason: `its files were edited ${sourceIdleMin} min ago — a session may be mid-edit`,
    };
  }
  return { live: false, reason: null };
}

/**
 * Minutes since the newest write under `.next`.
 *
 * Deliberately the MIRROR of repo-doctor's `idleMinutes`, which skips `.next` because build churn
 * would mask a dormant worktree. Here the churn IS the signal: a running `next dev` rewrites that
 * directory continuously, and AGENTS.md section 2.1 names it as one of the two things that see
 * what the retirement gates cannot. Returns null when there is no cache to read — the absence of a
 * build cache is not evidence of life and must never be read as one.
 */
export function buildCacheIdleMinutes(dir, { now = Date.now } = {}) {
  const root = path.join(dir, ".next");
  if (!fs.existsSync(root)) return null;
  let newest = 0;
  const visit = (d, depth) => {
    if (depth > 4) return; // the top levels carry the churn; a full walk of .next is enormous
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (e.isDirectory()) visit(p, depth + 1);
      } catch {
        /* vanished mid-walk — cannot be the newest one that matters */
      }
    }
  };
  visit(root, 0);
  if (newest === 0) return null;
  return Math.floor((now() - newest) / 60000);
}

/**
 * Run the PEB sweep once for the whole machine. One call, never one per worktree: it reads every
 * process on the system, so per-folder invocation would multiply that by the worktree count.
 */
export function readHolderProbe({ run = defaultRun } = {}) {
  try {
    return parseHolderProbe(run());
  } catch {
    return null;
  }
}

/**
 * The sweep script is resolved BESIDE THIS MODULE, never against the caller's cwd or the primary
 * checkout. repo-doctor runs from whichever worktree invoked it while reporting on the primary, so
 * a cwd-relative path finds a DIFFERENT checkout's copy of the script — one that predates the
 * `-Json` switch answers with a parameter-binding error, which lands as a null probe. That is safe,
 * because null fails closed, but it silently degrades every verdict to "cannot tell". Measured
 * exactly that way on 2026-09-08 before this line resolved from `import.meta.url`.
 */
function defaultRun() {
  const script = fileURLToPath(new URL("find-worktree-holder.ps1", import.meta.url));
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Json"],
    { encoding: "utf8", timeout: 60000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
}
