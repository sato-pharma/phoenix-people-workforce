#!/usr/bin/env node
// Guards against two Claude Code sessions editing the same working directory
// at once. See AGENTS.md "Session And Worktree Safety" for the policy this
// enforces. Invoked by the SessionStart/PreToolUse/SessionEnd hooks in
// .claude/settings.json.
//
// Ownership is tracked by session_id (stable and provided by the harness on
// every hook event for the same session), not by PID: a hook runs as a
// short-lived child process (shell -> node), so any PID captured here is
// already gone by the time a later hook invocation could check it. That makes
// PID-liveness checks unreliable from within a hook and they are intentionally
// not used to decide staleness. The `pid` field below is kept only as an
// informational breadcrumb in the warning message.
//
// ONE LOCK PER FOLDER. The lock lives in `<projectDir>/.claude/session.lock`,
// and settings.json passes CLAUDE_PROJECT_DIR — the session's OWN worktree —
// so a worktree session reads its worktree's lock, never the primary's.
//
// A LIVE SESSION REFRESHES ITS LOCK ("beat", on PreToolUse). Until 2026-09-17
// the lock was written once, at SessionStart, and staleness was its age — so
// any session that ran longer than STALE_MS (the norm here: sessions run for
// hours or days) left a lock reading abandoned while it was still editing, and
// a second session opening the same folder got no warning at all. Staleness is
// now the age of `refreshedAt` (falling back to `startedAt` for a lock an older
// hook wrote). A beat rewrites at most every BEAT_EVERY_MS, stays silent, and
// takes over a folder whose lock is missing or stale — never a fresh one.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const mode = process.argv[2]; // "start" | "beat" | "end"
const projectDir = process.argv[3] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const lockPath = path.join(projectDir, ".claude", "session.lock");
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — a crashed session's leftover lock self-expires this long after its last refresh
const BEAT_EVERY_MS = 5 * 60 * 1000; // a beat rewrites the lock at most this often
// A lock refreshed within LIVE_MS is PROOF its holder is alive, so the hook
// answers "is that other session still running?" itself instead of spending the
// owner's turn asking him. Measured 2026-09-21: 170 of 198 sessions in the
// primary hit the non-stale branch below, so that question fired on 86% of
// them — and the answer was always yes. Must stay comfortably above
// BEAT_EVERY_MS: a live session rewrites the lock at most every 5 minutes, so
// a lock younger than three beats cannot belong to a dead holder.
const LIVE_MS = 3 * BEAT_EVERY_MS; // 15 minutes

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/** When the holder was last seen: its latest refresh, or its start for a lock an older hook wrote. */
function lastSeen(lock) {
  return Date.parse(lock?.refreshedAt || lock?.startedAt || "");
}

function writeLock(sessionId, previous) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  const lock = {
    pid: process.ppid,
    // A refresh keeps the session's own start; a takeover starts fresh.
    startedAt: previous?.sessionId === sessionId && previous.startedAt ? previous.startedAt : now,
    refreshedAt: now,
    sessionId,
    host: os.hostname(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
}

function emit(result) {
  process.stdout.write(JSON.stringify(result));
}

function formatAge(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute(s) ago`;
  return `${Math.round(minutes / 60)} hour(s) ago`;
}

const input = readHookInput();

if (mode === "beat") {
  // No session id, no ownership to prove: a beat never invents one.
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);
  try {
    const lock = readLock();
    const ageMs = Date.now() - lastSeen(lock);
    if (lock && lock.sessionId === sessionId) {
      if (!(ageMs < BEAT_EVERY_MS)) writeLock(sessionId, lock);
    } else if (!lock || !Number.isFinite(ageMs) || ageMs > STALE_MS) {
      writeLock(sessionId, null);
    }
  } catch {
    // a heartbeat must never break a tool call
  }
  process.exit(0);
}

const sessionId = input.session_id || crypto.randomUUID();

if (mode === "end") {
  const lock = readLock();
  if (lock && lock.sessionId === sessionId) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone / nothing to clean up
    }
  }
  process.exit(0);
}

// mode === "start"
const lock = readLock();
if (lock && lock.sessionId !== sessionId) {
  const ageMs = Date.now() - lastSeen(lock);
  const stale = !Number.isFinite(ageMs) || ageMs > STALE_MS;
  if (!stale) {
    const when = formatAge(Date.now() - Date.parse(lock.startedAt || ""));
    const seen = formatAge(ageMs);
    // Two different situations hide behind one non-stale lock and they deserve
    // opposite answers. Under LIVE_MS the holder is provably alive, so there is
    // nothing to confirm: the session isolates itself and keeps working. Over
    // it, the holder may have crashed mid-task, and only the owner knows — that
    // is the one case worth his turn.
    const live = ageMs <= LIVE_MS;
    const shared =
      `Sessions sharing one folder have caused real incidents in this repo before (a session got ` +
      `git-detached by another session's checkout, a branch was auto-deleted mid-work by a second ` +
      `session reusing its name, a swarm of sessions dropped a staged file). Do NOT run ` +
      `git checkout/switch/reset/branch -D, do NOT commit or push, and do NOT edit files in this folder.`;
    const warning = live
      ? `Another Claude Code session is ACTIVE in this exact working directory ` +
        `(${projectDir}) and is provably LIVE: started ${when}, last active ${seen}, on host ` +
        `${lock.host || "unknown"}. ${shared} ` +
        `Do NOT ask the owner whether that other session is still running — a lock refreshed ` +
        `${seen} IS the proof, because a live session rewrites it on every Bash, PowerShell, Edit ` +
        `and Write call. Isolate yourself and carry on with his task WITHOUT stopping: run ` +
        `\`node scripts/new-session.mjs <task>\`, which creates _wt-<task> on codex/<task> from ` +
        `origin/main with .env.local and a node_modules junction, then do every edit, command and ` +
        `commit there. READING this folder stays fine. Mention the move in one line at most — it is ` +
        `routine, it is not a blocker, and it is never a reason to hand the task back to him.`
      : `Another Claude Code session may still be ACTIVE in this exact working directory ` +
        `(${projectDir}): started ${when}, last active ${seen}, on host ${lock.host || "unknown"}. ` +
        `${shared} That lock is older than a live session's refresh interval, so its holder may have ` +
        `crashed mid-task — confirm with the owner whether it is still running before you touch this ` +
        `folder. If he wants new work started right now, run \`node scripts/new-session.mjs <task>\` ` +
        `and work there instead. A leftover lock self-expires 2 hours after its last refresh — ` +
        `that AGE is the only staleness test. Do NOT check the PID: it is this hook's own short-lived ` +
        `parent shell, dead within seconds of the lock being written, so EVERY lock names a dead PID ` +
        `and "that process is gone" proves nothing about the session.`;
    emit({
      systemMessage: live
        ? `Folder held by a live session (last active ${seen}) — isolate into a worktree and continue; no confirmation needed.`
        : `Warning: another session's lock (last active ${seen}) may be active in this folder.`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: warning,
      },
    });
    process.exit(0);
  }
}

writeLock(sessionId, lock);
emit({ systemMessage: `Session lock acquired for ${projectDir}` });
process.exit(0);
