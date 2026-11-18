// session-folder.mjs — the folder a Claude Code session belongs to, for a hook to act on.
//
// WHY THIS EXISTS (2026-11-18, desktop-app audit). Every folder-keyed hook here used to take
// CLAUDE_PROJECT_DIR as "the session's own worktree". That was measured on 2026-09-12 in a CLI
// session and is true there. It is NOT true in the desktop app: a desktop session runs in its own
// `.claude/worktrees/<name>` folder, yet its hooks receive the PRIMARY checkout as CLAUDE_PROJECT_DIR
// and run with the primary as their working directory. Measured on 2026-11-18: session-lock.mjs
// printed the primary's path from inside a worktree session. The result, in every desktop session:
//   - primary-write-guard.mjs took the primary as the session's own tree, and every worktree lives
//     inside the primary, so it allowed every write into every other session's worktree;
//   - session-lock.mjs read and refreshed the PRIMARY's lock, so each new session got a false
//     "another session is active in this folder" alarm, and the worktree's own lock was never kept;
//   - worktree-exit-guard.mjs saw the primary and stayed silent at every session end (its log has no
//     SessionEnd entry since 2026-10-02);
//   - sync-worktree-env.mjs said "this IS the primary — nothing to sync", so a new worktree never got
//     a fresh copy of the primary's env files.
//
// WHAT NEVER MOVES. Every hook payload carries `transcript_path`, and Claude Code files a session's
// transcript under `<config>/projects/<slug>/`, where <slug> is the folder the session STARTED in
// with every character that is not a letter or digit turned into `-`. That holds in the CLI, the
// desktop app and a cloud session, and it does not follow a `cd` — unlike the payload's `cwd`. So the
// session's folder is the candidate folder whose slug equals the transcript's. Candidates, in order:
//   1. each folder from the payload's `cwd`, CLAUDE_PROJECT_DIR and the working directory up to the
//      drive root (a session started in a subfolder answers like that subfolder);
//   2. every worktree registered with the repository those folders sit in, so a session that has
//      `cd`-ed into another checkout still resolves to its own.
// The match is case-insensitive (Windows paths are). When nothing matches — no transcript path, a
// hand run, a slug Claude Code shortened — the answer is what the hooks used before:
// CLAUDE_PROJECT_DIR, then the working directory. Nothing here starts a process: it is fs reads only,
// because session-lock.mjs and primary-write-guard.mjs run on every tool call.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { gitLayout } from './git-layout.mjs';

/** Claude Code's project slug for a folder: every character that is not a letter or digit becomes `-`. */
export function projectSlug(folder) {
  return String(folder).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Every path segment that follows a `projects` segment in a transcript path, lower-cased. A subagent's
 * transcript sits deeper under the same slug folder, and a config folder may itself sit under some
 * other `projects` folder, so every candidate is kept rather than guessing which one is the slug.
 */
export function transcriptSlugs(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return new Set();
  const parts = transcriptPath.split(/[\\/]+/);
  const out = new Set();
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i].toLowerCase() === 'projects' && parts[i + 1]) out.add(parts[i + 1].toLowerCase());
  }
  return out;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The folder and each of its parents, up to the root. */
function ancestors(start) {
  const out = [];
  let dir;
  try {
    dir = path.resolve(start);
  } catch {
    return out;
  }
  for (;;) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** The primary checkout and every registered worktree of the repository `start` sits in, read off disk. */
function registeredTrees(start) {
  const layout = gitLayout(start);
  if (!layout) return [];
  const trees = [path.dirname(layout.commonDir)];
  try {
    const base = path.join(layout.commonDir, 'worktrees');
    for (const entry of readdirSync(base)) {
      try {
        const pointer = readFileSync(path.join(base, entry, 'gitdir'), 'utf8').trim();
        if (pointer) trees.push(path.dirname(pointer));
      } catch {
        /* a half-removed worktree — skip it */
      }
    }
  } catch {
    /* no worktrees folder at all */
  }
  return trees;
}

/** A matched folder's checkout root (a subfolder answers like its root), with native separators. */
function rootOf(folder) {
  return path.resolve(gitLayout(folder)?.toplevel ?? folder);
}

/**
 * The folder this session belongs to.
 *
 * @param {{ cwd?: string, transcript_path?: string } | null | undefined} input  the hook payload
 * @param {{ env?: Record<string, string | undefined>, cwd?: string }} [options]  for tests
 * @returns {string} an absolute path; never empty when the working directory is known
 */
export function sessionFolder(input, { env = process.env, cwd = process.cwd() } = {}) {
  const fallback = env.CLAUDE_PROJECT_DIR || cwd;
  // It never throws: the hooks call it before their own fail-open handlers are installed.
  try {
    const slugs = transcriptSlugs(input?.transcript_path);
    if (slugs.size === 0) return fallback;
    const fits = (folder) => slugs.has(projectSlug(folder).toLowerCase());

    const starts = [input?.cwd, env.CLAUDE_PROJECT_DIR, cwd].filter((s) => typeof s === 'string' && s && isDir(s));
    for (const start of starts) {
      for (const folder of ancestors(start)) if (fits(folder)) return rootOf(folder);
    }
    for (const start of starts) {
      for (const tree of registeredTrees(start)) if (fits(path.resolve(tree))) return rootOf(tree);
    }
  } catch {
    /* an unreadable layout — answer what the hooks answered before */
  }
  return fallback;
}

/** One folder written two ways — separators, letter case, a trailing slash — is still one folder. */
export function sameFolder(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * The hook payload on stdin, or {} when there is none. A terminal is never read — reading fd 0 there
 * waits for an end-of-file nobody types — so a script that runs both as a hook and by hand can call
 * this safely. Inside hook-dispatch.mjs, fd 0 is answered from memory.
 */
export function readHookPayload() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = readFileSync(0, 'utf8');
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
