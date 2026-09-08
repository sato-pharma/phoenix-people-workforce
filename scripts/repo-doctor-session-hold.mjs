/**
 * Is a Claude Code session standing in this worktree right now?
 *
 * Split out of repo-doctor.mjs for the reason the other repo-doctor-*.mjs modules were: that file
 * executes on import, so nothing inside it can be driven by a test, and this rule decides whether a
 * folder is offered for deletion. It cost two live sessions their worktrees on 2026-09-08 by being
 * absent, which is not the kind of thing to leave un-exercised.
 *
 * WHAT WENT WRONG. Every retirability gate in repo-doctor reads the FOLDER — uncommitted files,
 * commits on no origin ref, source mtimes, the newest PR's state. A session that is open but
 * between turns writes none of them. Both worktrees taken that day were clean, merged, and idle by
 * every one of those measures, and both had a session sitting in them. The report printed
 * ready-to-paste `git worktree remove` lines and something ran them, leaving two sessions in a
 * DEREGISTERED worktree — where `pwd` still names the folder while every bare git command silently
 * resolves against the primary checkout, which is on `main`, production's branch.
 *
 * WHY NOT THE LOCK. `.claude/session.lock` (see .claude/hooks/session-lock.mjs) looks like the
 * natural signal and is not. SessionEnd deletes it, an already-emptied folder has none at all, and
 * measured on this machine when this was written it existed in 2 of 14 worktrees. Its own header
 * also explains why its `pid` cannot be interrogated: the lock names the hook's short-lived parent
 * shell, so every lock names a dead PID.
 *
 * WHAT IS USED INSTEAD. Claude Code writes one `<sessionId>.jsonl` transcript per session under
 * `~/.claude/projects/<cwd, every character outside [A-Za-z0-9] replaced by "-">/`, and appends on
 * every turn. The newest mtime in that directory is therefore "when did a session in this folder
 * last speak" — a durable record rather than a process to interrogate.
 *
 * THE BLIND SPOT IS DELIBERATE AND MUST STAY VISIBLE. A sibling `_wt-*` session reports the PRIMARY
 * as its cwd (AGENTS.md §2.1), so its activity lands in the primary's project directory and cannot
 * be told apart from any other session's. This protects `.claude/worktrees/*` reliably and `_wt-*`
 * not at all. That is exactly the class that was lost, so it earns its place — but an `_wt-*`
 * folder this reports as unheld is UNKNOWN, never proven unattended, and the caller must say so.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Two hours, matching the only staleness window this repo has ever used for a session — the
 * `.claude/session.lock` expiry. Deliberately generous: this rule only ever SUBTRACTS from what is
 * offered for removal, so erring long costs a worktree that stays one more day, while erring short
 * costs somebody their working folder mid-task.
 */
export const SESSION_HELD_MIN = 120;

/**
 * The directory name Claude Code derives from a working directory.
 *
 * Verified against this machine on 2026-09-08: `F:\Phoenix Workforce\phoenix-workforce\.claude\
 * worktrees\zealous-dewdney-7afb5e` encodes to
 * `F--Phoenix-Workforce-phoenix-workforce--claude-worktrees-zealous-dewdney-7afb5e`, which is the
 * directory that exists. The doubled dashes are not a quirk to special-case — they fall out of
 * `:\` and `\.` each being two replaced characters.
 */
export function encodeProjectDirName(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Minutes since a session whose cwd is `dir` last wrote a turn, or null when none ever has.
 *
 * `homedir` and `now` are injectable so a test can build a fixture tree instead of depending on
 * whatever sessions happen to be open on the machine running it.
 */
export function sessionActivityMinutes(dir, options = {}) {
  const home = options.homedir ?? os.homedir();
  const now = options.now ?? Date.now();
  const projectDir = path.join(home, ".claude", "projects", encodeProjectDirName(dir));

  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null; // no session has ever run in this folder
  }

  let newest = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const m = fs.statSync(path.join(projectDir, entry.name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* a transcript that vanished mid-read cannot be the newest one that matters */
    }
  }
  if (newest === 0) return null;
  return Math.floor((now - newest) / 60000);
}

/**
 * The reason this folder must not be offered for removal, or null when nothing holds it.
 *
 * A string rather than a boolean because the caller prints it, and a held worktree that vanishes
 * from the report without explanation reads as "that folder is gone" rather than "somebody is in
 * it" — the same distinction repo-doctor already draws for its PR-state holds.
 */
export function sessionHoldReason(dir, options = {}) {
  const mins = sessionActivityMinutes(dir, options);
  if (mins === null || mins >= (options.heldMin ?? SESSION_HELD_MIN)) return null;
  return `a session spoke in this folder ${mins} min ago — removing it deregisters the worktree under a live session`;
}
