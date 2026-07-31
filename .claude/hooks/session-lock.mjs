#!/usr/bin/env node
// Guards against two Claude Code sessions editing the same working directory
// at once. See AGENTS.md "Session And Worktree Safety" for the policy this
// enforces. Invoked by the SessionStart/SessionEnd hooks in .claude/settings.json.
//
// Ownership is tracked by session_id (stable and provided by the harness on
// both SessionStart and SessionEnd for the same session), not by PID: a hook
// runs as a short-lived child process (shell -> node), so any PID captured
// here is already gone by the time a later hook invocation could check it.
// That makes PID-liveness checks unreliable from within a hook and they are
// intentionally not used to decide staleness. The `pid` field below is kept
// only as an informational breadcrumb in the warning message.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const mode = process.argv[2]; // "start" | "end"
const projectDir = process.argv[3] || process.cwd();
const lockPath = path.join(projectDir, ".claude", "session.lock");
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — a crashed session's leftover lock self-expires after this

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

function writeLock(sessionId) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = {
    pid: process.ppid,
    startedAt: new Date().toISOString(),
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
  const ageMs = Date.now() - Date.parse(lock.startedAt || "");
  const stale = !Number.isFinite(ageMs) || ageMs > STALE_MS;
  if (!stale) {
    const when = formatAge(ageMs);
    const warning =
      `Another Claude Code session appears to be ACTIVE in this exact working directory ` +
      `(${projectDir}): reported PID ${lock.pid ?? "unknown"}, started ${when} on host ` +
      `${lock.host || "unknown"}. Sessions sharing one folder have caused real incidents in ` +
      `this repo before (a session got git-detached by another session's checkout, a branch was ` +
      `auto-deleted mid-work by a second session reusing its name, a swarm of sessions dropped a ` +
      `staged file). Do NOT run git checkout/switch/reset/branch -D, do NOT commit or push, and do ` +
      `NOT edit files in this folder until you have explicitly confirmed with the user whether that ` +
      `other session is still running. If the user wants to start new work right now, create an ` +
      `isolated worktree instead: git worktree add <path> -b <branch>, and do the new work there. ` +
      `Note: a session that crashed or was force-closed leaves its lock behind (it self-expires ` +
      `after 2 hours) — if the reported PID is not a running process, the lock is stale.`;
    emit({
      systemMessage: `Warning: another session's lock (PID ${lock.pid ?? "unknown"}, ${when}) is active in this folder.`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: warning,
      },
    });
    process.exit(0);
  }
}

writeLock(sessionId);
emit({ systemMessage: `Session lock acquired for ${projectDir}` });
process.exit(0);
