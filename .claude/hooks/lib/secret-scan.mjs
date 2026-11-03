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
//      nothing. `readPushes` reads the `cd` the command itself makes.
//
// A TIMED-OUT SCAN WARNS AND ALLOWS, like a missing gitleaks does: a scanner that holds every push
// for 90s is switched off within the hour, and the daily scheduled scan over `main` is the backstop.
//
// 🔴 A COMMAND THAT COMMITS AND PUSHES IS REFUSED, NOT SCANNED, BECAUSE NOTHING IT WILL SEND EXISTS YET.
// This runs before the whole command starts. On 3 Nov 2026 `git add … && git commit … && git push`
// read zero commits and carried a JWT out; the next push, with the commit in place, was refused for
// it. `gitleaks git --staged` cannot answer it either, since that command's `git add` has not run:
// on a JWT written but not yet added it exits 0, then 1 once added. Account: `docs/hook-dispatcher.md`.
//
// 🔴 IT READS EVERY PUSH THE COMMAND MAKES, WORD BY WORD, AND SCANS WHAT THAT PUSH SENDS. A regex on the
// command's start missed `timeout 90 git push` (547 calls in 14 days) and `git -C "$WT" push` (77), and
// `origin/main..HEAD` read the wrong commits for `git push origin other`. What it cannot name before the
// command runs it refuses, and the refusal says what to write; that is 81 of 2,153 lone pushes.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { argvTokens, changedDirectory, isGitWord, parseGitTokens, readPush, withoutRedirects } from './git-command.mjs';

/** Well inside the dispatcher's 90s budget; a normal scan takes under a second. */
export const SECRET_SCAN_TIMEOUT_MS = 20000;

const DEFAULT_RANGE = 'origin/main..HEAD';

/** The arguments CI's scan used, narrowed to the commits a push adds. */
const gitleaksArgs = (range) => ['git', '.', `--log-opts=${range}`, '--redact', '--no-banner'];
export const GITLEAKS_ARGS = gitleaksArgs(DEFAULT_RANGE);

function toPath(word) {
  let p = word;
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

const gitOut = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    windowsHide: true,
  }).trim();

// These five make a commit whose content the scan has never seen. `pull` and `rebase` are left out:
// they bring what the remote already holds, or rewrite commits the scan can already read.
const MAKES_A_COMMIT = new Set(['commit', 'cherry-pick', 'revert', 'am', 'merge']);
const MAKES_NO_COMMIT = new Set(['--dry-run', '--abort', '--quit', '--help', '-h']);
const MOVES_HEAD = new Set(['switch', 'checkout', 'reset']);

const LEADING_KEYWORD = /^\s*(?:try|if|elif|then|else|do|while|until|\{|!)\s+/;

/** C12 reads this many repositories in one command; each scan may take its full cap. */
const MOST_REPOSITORIES = 2;

/**
 * `$(git rev-parse X)` and `$(git branch --show-current)` name a commit the hook can read, so they
 * become that name. This runs before the command is split, since a split falls at the `(`.
 */
export function withKnownSubstitutions(text) {
  return text.replace(
    /\$\(git (?:rev-parse (?:--short(?:=\d+)? |--verify |--quiet |-q |--abbrev-ref )*"?((?!-)[^\s)"]+)"?|branch --show-current|symbolic-ref --short HEAD)\)/g,
    (_, name) => name ?? 'HEAD',
  );
}

/** A segment without its comment. Quoted text is masked first, so a `#` inside a path is left alone. */
function withoutComment(segment) {
  const at = segment.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (quoted) => '_'.repeat(quoted.length)).search(/(?:^|\s)#/);
  return at < 0 ? segment : segment.slice(0, at);
}

/** `NAME=value`, `export NAME=value`, `$NAME = value`, `$NAME=value`, `$env:NAME = value`. */
function assignment(tokens) {
  const words = tokens[0] === 'export' ? tokens.slice(1) : tokens;
  const shape =
    words.length === 3 && words[1] === '='
      ? [words[0].replace(/^\$(?:env:)?/i, ''), words[2], words[0].startsWith('$')]
      : words.length === 1
        ? (/^\$?(?:env:)?([A-Za-z_]\w*)=(.*)$/is.exec(words[0]) ?? []).slice(1).concat(true)
        : [];
  return shape[2] && /^[A-Za-z_]\w*$/.test(shape[0] ?? '') ? { name: shape[0], value: shape[1] ?? '' } : null;
}

/**
 * Every push in a command, read in order as the shell would run it. `segments` is the command split at
 * its command positions, and shell variables reset between tool calls, so a folder named by a variable
 * is either set in this same command or comes from the environment. `dir` is null with `unread` naming
 * the word when the folder cannot be known yet: a loop variable, a `$(…)`, a folder not there.
 */
export function readPushes(segments, baseCwd) {
  const vars = new Map();
  let dir = baseCwd;
  let unread = null;
  let committed = false;
  let movedHead = false;
  const pushes = [];

  const expand = (word) =>
    String(word).replace(/\$(?:env:)?(?:\{(\w+)\}|(\w+))/gi, (whole, braced, bare) => {
      const name = braced ?? bare;
      if (vars.has(name)) return vars.get(name);
      if (name === 'PWD' && dir) return dir;
      return process.env[name] ?? whole;
    });
  const folder = (word, from) => {
    const text = expand(word);
    if (/[$`]/.test(text) || !from) return null;
    const path = resolve(from, toPath(text));
    return isDir(path) ? path : null;
  };

  for (const segment of segments) {
    const code = withoutComment(segment).replace(LEADING_KEYWORD, '');
    const words = withoutRedirects(argvTokens(code));
    const assigned = assignment(words);
    if (assigned) {
      // An empty value is `X=$(…) || X=""`, which says nothing about what X will hold.
      const value = expand(assigned.value);
      if (!value || /[$`]/.test(value)) vars.delete(assigned.name);
      else vars.set(assigned.name, value);
      continue;
    }
    const moved = changedDirectory(code);
    if (moved) {
      dir = folder(moved, dir);
      unread = dir ? null : (unread ?? moved);
      continue;
    }

    // `git` anywhere in the segment rather than at its start: `timeout 60 git push`, `then git push`
    // and PowerShell's own `if ($?) { git push }` are all pushes. A false reading costs one quick scan.
    const start = words.findIndex(isGitWord);
    if (start < 0) continue;
    const stop = words.findIndex((word, i) => i > start && /^[)}]$/.test(word));
    const git = parseGitTokens(
      words
        .slice(start, stop < 0 ? undefined : stop)
        .map((word) => (/[({]/.test(word) ? word : word.replace(/[)}]+$/, ''))),
    );
    if (!git) continue;

    if (git.sub === 'push') {
      const read = readPush(git.args);
      if (read.sendsNothing) continue;
      const sources = read.refspecs.length
        ? read.refspecs
            .map((spec) => spec.replace(/^\+/, ''))
            .filter((spec) => !spec.startsWith(':'))
            .map((spec) => expand(spec.split(':')[0]))
        : ['HEAD'];
      if (!sources.length && !read.wide) continue; // `git push origin :old` deletes and sends nothing
      const pushDir = git.dir ? folder(git.dir, dir) : dir;
      pushes.push({
        dir: pushDir,
        unread: pushDir ? null : (git.dir ?? unread),
        sources,
        wide: read.wide,
        afterCommit: committed,
        afterHeadMove: movedHead,
      });
    } else if (MAKES_A_COMMIT.has(git.sub) && !git.args.some((arg) => MAKES_NO_COMMIT.has(arg))) {
      committed = true;
    } else if (MOVES_HEAD.has(git.sub) && !git.args.includes('--')) {
      movedHead = true;
    }
  }
  return pushes;
}

/** The repository `dir` is in, when it is THIS repository: `.gitleaks.toml` at its root says so. */
function ourRoot(dir) {
  try {
    const root = gitOut(dir, ['rev-parse', '--show-toplevel']);
    return existsSync(join(root, '.gitleaks.toml')) ? root : null;
  } catch {
    return null;
  }
}

function isCommit(root, name) {
  try {
    gitOut(root, ['rev-parse', '--verify', '-q', `${name}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What C12 does with this command. The hook runs before any of it starts, so it can only read what
 * already exists. When it cannot name the folder or the commits, it refuses and says how to fix it:
 *
 *   `{ refuse: 'commit' | 'head' | 'folder' | 'ref' | 'wide', word }`
 *   `{ targets: [{ root, range }] }`, one per repository of ours, each push's commits past origin/main.
 */
export function pushScanPlan(segments, baseCwd) {
  const pushes = readPushes(segments, baseCwd);
  const sources = new Map();
  for (const push of pushes) {
    const root = ourRoot(push.dir ?? baseCwd);
    if (!root) continue;
    if (push.afterCommit) return { refuse: 'commit' };
    if (!push.dir) return { refuse: 'folder', word: push.unread };
    if (push.wide) return { refuse: 'wide', word: push.wide };
    if (push.afterHeadMove && push.sources.some((s) => s === 'HEAD' || s === '@')) return { refuse: 'head' };
    for (const source of push.sources) {
      if (!isCommit(root, source)) return { refuse: 'ref', word: source };
      if (!sources.has(root)) sources.set(root, new Set());
      sources.get(root).add(source);
    }
  }
  if (sources.size > MOST_REPOSITORIES) return { refuse: 'wide', word: `${sources.size} repositories` };
  return {
    targets: [...sources].map(([root, names]) => ({
      root,
      range: [...names].map((name) => `origin/main..${name}`).join(' '),
    })),
  };
}

/** Why C12 refuses, for the plan `pushScanPlan` returned, and what to run instead. */
export function pushRefusalReason({ refuse, word }) {
  if (refuse === 'commit') {
    return (
      'C12 — this command both commits and pushes, so it is refused before any of it runs. Nothing ' +
      'has been staged, committed or pushed.\n\n' +
      'The secret scan runs before the whole command starts, when the commit it has to read does ' +
      'not exist yet, so it would check everything except what this push adds. On 3 Nov 2026 that ' +
      'let a JWT out, and the next push was refused for it, too late.\n\n' +
      'Run them as two commands: commit first, then the push on its own, and the scan reads the new commit.'
    );
  }
  const opening = {
    head:
      'C12 — this command moves HEAD (`git switch`, `git checkout` or `git reset`) and then pushes it, ' +
      'so it is refused before any of it runs. The scan runs first, when HEAD is still the old commit.\n\n' +
      'Run them as two commands: move first, then the push on its own.',
    folder:
      `C12 — this push runs in a folder the command does not name yet (\`${word}\`), so the secret scan ` +
      'cannot read it and it is refused before any of it runs.\n\n' +
      'Set the folder in the same command as a plain value (`WT="<folder>"; git -C "$WT" push`), or name it.',
    ref:
      `C12 — this push sends \`${word}\`, which is not a commit yet, so the secret scan cannot read it and ` +
      'it is refused before any of it runs.\n\n' +
      'Name a branch, tag or commit that already exists, in the same command as a plain value.',
    wide:
      `C12 — this push sends more than the scan reads at once (\`${word}\`), so it is refused before any ` +
      'of it runs.\n\nPush them one at a time, by name.',
  };
  return opening[refuse];
}

/** How many commits `range` holds; null when git cannot say. */
export function commitsAhead(root, range = DEFAULT_RANGE) {
  try {
    const n = Number.parseInt(gitOut(root, ['rev-list', '--count', ...range.split(' ')]), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Run gitleaks over the commits in `range`. `command` is the program and any leading arguments (the
 * tests put a fake scanner here); the arguments for that range follow it.
 *
 * @returns {{ status: 'clean' | 'found' | 'missing' | 'timed-out' | 'error', output: string }}
 */
export function scanBranchCommits(root, { timeoutMs = SECRET_SCAN_TIMEOUT_MS, command = ['gitleaks'], range = DEFAULT_RANGE } = {}) {
  const [bin, ...lead] = command;
  try {
    execFileSync(bin, [...lead, ...gitleaksArgs(range)], {
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
