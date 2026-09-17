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
const projectDir = process.argv[3] || process.cwd();
const lockPath = path.join(projectDir, ".claude", "session.lock");
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — a crashed session's leftover lock self-expires this long after its last refresh
const BEAT_EVERY_MS = 5 * 60 * 1000; // a beat rewrites the lock at most this often

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
    const warning =
      `Another Claude Code session appears to be ACTIVE in this exact working directory ` +
      `(${projectDir}): reported PID ${lock.pid ?? "unknown"}, started ${when}, last active ${seen}, on host ` +
      `${lock.host || "unknown"}. Sessions sharing one folder have caused real incidents in ` +
      `this repo before (a session got git-detached by another session's checkout, a branch was ` +
      `auto-deleted mid-work by a second session reusing its name, a swarm of sessions dropped a ` +
      `staged file). Do NOT run git checkout/switch/reset/branch -D, do NOT commit or push, and do ` +
      `NOT edit files in this folder until you have explicitly confirmed with the user whether that ` +
      `other session is still running. If the user wants to start new work right now, create an ` +
      `isolated worktree instead: git worktree add <path> -b <branch>, and do the new work there. ` +
      `Note: a live session refreshes its lock on every Bash, PowerShell, Edit or Write call, and a ` +
      `session that crashed or was force-closed leaves its lock behind, which self-expires 2 hours ` +
      `after its last refresh — that AGE is the only staleness test. Do NOT check the PID above: it is this ` +
      `hook's own short-lived parent shell, dead within seconds of the lock being written, so EVERY ` +
      `lock names a dead PID and "that process is gone" proves nothing about the session.`;
    emit({
      systemMessage: `Warning: another session's lock (PID ${lock.pid ?? "unknown"}, last active ${seen}) is active in this folder.`,
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
