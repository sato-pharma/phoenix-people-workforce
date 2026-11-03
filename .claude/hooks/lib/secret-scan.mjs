// The pre-push secret scan behind bash-guard C12 — WHERE it scans, WHETHER it needs to, and a run of
// gitleaks that can never outlast the hook that calls it.
//
// WHY THIS IS ITS OWN FILE. On 23 Oct 2026, 08:40–10:13 Cairo, every `git push` from every session
// spent 30–95s inside this scan, and three of them crossed the 90s budget `settings.json` gives the
// PreToolUse dispatcher. Claude Code then killed the dispatcher whole, so for those pushes EVERY
// guard's answer was lost, not just this one's — they ran with no checks at all. Three things made
// that possible, and each is fixed here:
//
//   1. The gitleaks call had a 120s timeout, longer than the 90s it lived inside. And bash-guard
//      runs IN-PROCESS in the dispatcher (`runInProcess`), which starts no per-hook timer, so a
//      synchronous child that runs long holds the whole dispatcher. The cap below is the only cap.
//   2. It ran through `shell: true`, so a timeout killed `cmd.exe` and left gitleaks running on as
//      an orphan (measured: the grandchild survives the kill; spawned directly, scoop's shim takes
//      gitleaks down with it). Spawned directly, it also stops printing node's DEP0190 warning.
//   3. It scanned the session's cwd — the PRIMARY checkout — when the push was `cd <worktree> &&
//      git push`. Every one of those 23 Oct pushes was from a worktree, so the scan looked at the
//      wrong repository, whose `origin/main..HEAD` was empty: it cost the full wait and checked
//      nothing. `pushTargetDir` reads the `cd` the command itself makes.
//
// A TIMED-OUT SCAN WARNS AND ALLOWS, like a missing gitleaks does: a scanner that holds every push
// for 90s is switched off within the hour, and the daily scheduled scan over `main` is the backstop.
//
// 🔴 A COMMAND THAT COMMITS AND PUSHES IS REFUSED, NOT SCANNED, BECAUSE NOTHING IT WILL SEND EXISTS YET.
// This runs before the whole command starts. On 3 Nov 2026 `git add … && git commit … && git push`
// read zero commits and carried a JWT out; the next push, with the commit in place, was refused for
// it. `gitleaks git --staged` cannot answer it either, since that command's `git add` has not run:
// on a JWT written but not yet added it exits 0, then 1 once added. Account: `docs/hook-dispatcher.md`.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Well inside the dispatcher's 90s budget; a normal scan takes under a second. */
export const SECRET_SCAN_TIMEOUT_MS = 20000;

/** The arguments CI's scan used, narrowed to the commits this branch adds. */
export const GITLEAKS_ARGS = ['git', '.', '--log-opts=origin/main..HEAD', '--redact', '--no-banner'];

// `cd X`, `pushd X`, `Set-Location X` / `sl X` / `chdir X`, at the start of a command segment.
const CD = /(?:^|[\n;&|(])\s*(?:cd|pushd|chdir|set-location|sl)(?:\s+-(?:LiteralPath|Path))?\s+("[^"]*"|'[^']*'|(?:\\.|[^\s;&|)])+)/gi;

function toPath(word) {
  let p = word;
  if (/^(["']).*\1$/s.test(p)) p = p.slice(1, -1);
  else p = p.replace(/\\([\s'"()&;|])/g, '$1'); // bash's `Phoenix\ Workforce`; a Windows `\` stays
  if (p === '~' || /^~[\\/]/.test(p)) p = homedir() + p.slice(1);
  if (process.platform === 'win32' && /^\/[a-zA-Z](?:\/|$)/.test(p)) p = `${p[1]}:/${p.slice(3)}`; // MSYS /f/…
  return p;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory the push runs in, from the `cd`s the command makes before it — `textBeforePush` is
 * the command up to and including the `git push`. Relative `cd`s chain off each other and off
 * `baseCwd`. Null when the command changes no directory, or lands somewhere that does not exist.
 */
export function pushTargetDir(textBeforePush, baseCwd) {
  let dir = null;
  for (const m of String(textBeforePush).matchAll(CD)) {
    const p = toPath(m[1]);
    if (!p || p === '-') continue;
    dir = resolve(dir ?? baseCwd ?? process.cwd(), p);
  }
  return dir && isDir(dir) ? dir : null;
}

// A quoted string names a command; it does not run one, and `-C "<a folder>"` is one word either way.
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;

// `git` anywhere in the segment rather than at its start: `timeout 60 git push`, `then git push` and
// PowerShell's own `if ($?) { git push }` are all pushes. With quotes and comments gone, what is left
// is one command's words, and a false refusal only costs splitting the command.
const runsGit = (verbs) =>
  new RegExp(String.raw`(?:^|[\s{])git(?:\.exe)?\s+(?:-[cC]\s+(?:\\\s|\S)+\s+|--?\S+\s+)*(?:${verbs})(?:\s|$)`, 'i');

// `pull` and `rebase` are left out: they bring what the remote already holds, or rewrite commits the
// scan can already read. These five make a commit whose content that scan has never seen.
const MAKES_A_COMMIT = runsGit('commit|cherry-pick|revert|am|merge');
const MAKES_NO_COMMIT = /\s(?:--dry-run|--abort|--quit|--help|-h)(?=\s|$)/;
const PUSHES = runsGit('push');
const SENDS_NO_COMMIT = /\s(?:--dry-run|--delete|--help|-[a-z]*[ndh][a-z]*)(?=\s|$)/;

/**
 * Does this command make a commit and then push it? `segments` is the command split at its command
 * positions. A push BEFORE the commit carries only what the scan can read, so the order matters.
 */
export function commitsThenPushes(segments) {
  let committed = false;
  for (const segment of segments) {
    const text = segment.replace(QUOTED, '""').replace(/(?:^|\s)#.*$/, '');
    if (committed && PUSHES.test(text) && !SENDS_NO_COMMIT.test(text)) return true;
    if (MAKES_A_COMMIT.test(text) && !MAKES_NO_COMMIT.test(text)) committed = true;
  }
  return false;
}

/** How many commits HEAD has that `origin/main` lacks; null when git cannot say. */
export function commitsAhead(root) {
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'origin/main..HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Run gitleaks over the commits `root`'s branch adds. `command` is the program and any leading
 * arguments (the tests put a fake scanner here); `GITLEAKS_ARGS` follow it.
 *
 * @returns {{ status: 'clean' | 'found' | 'missing' | 'timed-out' | 'error', output: string }}
 */
export function scanBranchCommits(root, { timeoutMs = SECRET_SCAN_TIMEOUT_MS, command = ['gitleaks'] } = {}) {
  const [bin, ...lead] = command;
  try {
    execFileSync(bin, [...lead, ...GITLEAKS_ARGS], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      // 🔴 NO `shell`. Through cmd.exe a timeout kills the shell and orphans the scanner.
    });
    return { status: 'clean', output: '' };
  } catch (err) {
    const e = /** @type {{status?: number|null, code?: string, stderr?: string, stdout?: string}} */ (err);
    if (e?.code === 'ETIMEDOUT') return { status: 'timed-out', output: '' };
    // gitleaks exits 1 when it finds something and 126/127/ENOENT when it is not installed.
    if (e?.code === 'ENOENT' || e?.status === 127 || e?.status === 126) return { status: 'missing', output: '' };
    if (e?.status === 1) return { status: 'found', output: String(e.stderr || e.stdout || '').trim() };
    return { status: 'error', output: '' }; // a config error: allow, as before
  }
}
