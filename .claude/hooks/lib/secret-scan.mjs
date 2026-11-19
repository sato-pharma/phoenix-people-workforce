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
// 🔴 A COMMAND THAT COMMITS AND PUSHES CANNOT BE SCANNED HERE, BECAUSE NOTHING IT WILL SEND EXISTS YET.
// This runs before the whole command starts. On 3 Nov 2026 `git add … && git commit … && git push`
// read zero commits and carried a JWT out; the next push, with the commit in place, was refused for
// it. `gitleaks git --staged` cannot answer it either, since that command's `git add` has not run:
// on a JWT written but not yet added it exits 0, then 1 once added. So the plain Bash shape — adds,
// a commit, one push to origin on a `claude/`/`codex/` branch — is REWRITTEN with the scan between
// the commit and the push (`commitPushRewrite`, the owner's choice of 20 Nov 2026: 218 refusals a
// week), and a finding stops the push with the commit left local. Every other shape is refused as
// before, and the rewrite never throws: bash-guard fails open. Account: `docs/hook-dispatcher.md`.
//
// 🔴 IT READS EVERY PUSH THE COMMAND MAKES, WORD BY WORD, AND SCANS WHAT THAT PUSH SENDS. A regex on the
// command's start missed `timeout 90 git push` (547 calls in 14 days) and `git -C "$WT" push` (77), and
// `origin/main..HEAD` read the wrong commits for `git push origin other`. What it cannot name before the
// command runs it refuses, and the refusal says what to write; that is 81 of 2,153 lone pushes.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { argvTokens, changedDirectory, commandSegments, isGitWord, parseGitTokens, readPush, withoutRedirects } from './git-command.mjs';

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

// ── The scan INSIDE a commit-and-push (owner, 20 Nov 2026: "Scan inside the command") ─────────────
//
// 🔴 WHY. A command that commits and then pushes was refused outright (above), and sessions kept
// writing it: 218 refusals in the week to 20 Nov 2026, each one a wasted round trip. The hook cannot
// scan a commit that does not exist yet — but the COMMAND can, once the commit has run. So the
// command is rewritten to run gitleaks between the commit and the push, joined by `&&`: a finding
// (or a scanner that will not start) stops the chain, and the push never runs. The commit stays
// local, where a reset still takes it back. That is the same protection as two commands, in one.
//
// 🔴 THE REWRITE IS ALSO AN `allow`, so it fires ONLY where nothing beyond what the repo's own
// `permissions.allow` already grants could ride along: Bash only (PowerShell 5.1 has no `&&`), every
// part of the command a `cd`, an assignment, an `echo`, a read-only git command, `git add`,
// `git commit` or the ONE push, which goes to `origin` on a `claude/` or `codex/` branch with no force.
// No `||`, no `if`, no loop, no subshell, no substitution but a quoted-heredoc commit message. And it
// keeps refusing when anything under `.claude/` is pending (C20 reads HEAD before the commit exists,
// so the mirror check could not see it) or when gitleaks is not installed. Every refusal is unchanged.

const QUOTED_HEREDOC = /<<-?\s*(['"])[A-Za-z_]\w*\1/;

/** Heredoc bodies removed, markers included — the same reading bash-guard's other clauses take. */
const withoutHeredocs = (text) => text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[ \t]*\2[ \t]*\r?$/gm, '');

/** Is `name` a program on PATH? Read from the folders, so a fake scanner in a test is never started. */
function onPath(name) {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const folder of String(process.env[key] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!folder) continue;
    for (const ext of exts) if (existsSync(join(folder, name + ext))) return true;
  }
  return false;
}

/**
 * The command split at its top level into `{ sep, text }` pieces, `sep` being what came before the
 * piece: `start`, `&&`, `;` or `|`. Null for anything this rewrite will not reason about.
 */
function topLevelPieces(text) {
  const pieces = [];
  let current = '';
  let quote = null;
  let sep = 'start';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"') {
        if (ch === '`') return null;
        if (text.startsWith('$(', i)) {
          // Only the shape a quoted heredoc leaves behind: `"$(cat <<'EOF' … EOF\n)"` → `"$(cat \n)"`.
          const shape = /^\$\(cat\s*\)/.exec(text.slice(i));
          if (!shape) return null;
          current += shape[0];
          i += shape[0].length - 1;
          continue;
        }
        if (ch === '\\') {
          current += ch + (text[i + 1] ?? '');
          i += 1;
          continue;
        }
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '||') return null;
    if (two === '&&') {
      pieces.push({ sep, text: current });
      current = '';
      sep = '&&';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      pieces.push({ sep, text: current });
      current = '';
      sep = ';';
      continue;
    }
    if (ch === '|') {
      pieces.push({ sep, text: current });
      current = '';
      sep = '|';
      continue;
    }
    if (ch === '&' && text[i - 1] !== '>') return null; // a background job
    if ('(){}`<'.includes(ch)) return null;
    current += ch;
  }
  if (quote) return null;
  pieces.push({ sep, text: current });
  return pieces;
}

/** A redirect other than `2>&1` or into /dev/null writes a file, which the rewrite does not vouch for. */
function writesAFile(piece) {
  const masked = piece.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (q) => '_'.repeat(q.length));
  return masked.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '').includes('>');
}

const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '--progress', '--no-progress', '-v', '--verbose', '--porcelain']);
const PIPE_READERS = new Set(['tail', 'head', 'grep']);
const OUR_BRANCH = /^(?:claude|codex)\/[\w./-]+$/;
const PUSH_AT_COMMAND_POSITION =
  /(^|&&|;|\n)([ \t]*)((?:PHX_\w+=\S*[ \t]+)*(?:timeout[ \t]+\d+[ \t]+)?git(?:[ \t]+-C[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\S+))?[ \t]+push\b)/g;

/** One piece read as `{ kind, git? }`, or null when the rewrite will not vouch for it. */
function classify(piece) {
  const text = piece.text.trim();
  if (!text) return { kind: 'empty' };
  if (writesAFile(text)) return null;
  let words = withoutRedirects(argvTokens(text));
  if (piece.sep === '|') return PIPE_READERS.has(words[0]) && !words.some((w) => /^-[A-Za-z]*[rR]/.test(w)) ? { kind: 'reader' } : null;
  if (words.length === 1 && /^[A-Za-z_]\w*=/.test(words[0])) return { kind: 'assign' };
  if (/^(?:cd|echo|pwd|true)$/.test(words[0])) return { kind: 'plain' };
  while (words.length && /^PHX_\w+=/.test(words[0])) words = words.slice(1);
  if (words[0] === 'timeout' && /^\d+$/.test(words[1] ?? '')) words = words.slice(2);
  if (!isGitWord(words[0] ?? '')) return null;
  // `-C <dir>` is the one global option; `-c` can set a config that runs a program.
  for (let i = 1; i < words.length && words[i].startsWith('-'); i += 2) if (words[i] !== '-C') return null;
  const git = parseGitTokens(words);
  if (!git) return null;
  if (git.sub === 'push') return { kind: 'push', git };
  if (git.sub === 'commit') return { kind: 'commit', git };
  if (git.sub === 'add') return git.args.some((a) => a === '-f' || a === '--force') ? null : { kind: 'add', git };
  if (READ_ONLY_GIT.has(git.sub)) return { kind: 'read', git };
  if (git.sub === 'branch' && git.args.length === 1 && git.args[0] === '--show-current') return { kind: 'read', git };
  return null;
}

/**
 * The commit-and-push command with the scan put between the commit and the push, or null when C12
 * should refuse it as before. `{ command, root, branch }`.
 *
 * 🔴 IT NEVER THROWS. bash-guard fails OPEN on any exception, so a throw here would let the commit
 * and push run with no scan at all — the 3 Nov hole. Any error is null, which is the old refusal.
 */
export function commitPushRewrite(options) {
  try {
    return rewriteOrNull(options);
  } catch {
    return null;
  }
}

function rewriteOrNull({ command, tool, baseCwd }) {
  if (!/^bash$/i.test(String(tool ?? ''))) return null;
  // Every heredoc must be quoted, so its body expands nothing; a here-string is not read at all.
  if (/<<</.test(command)) return null;
  for (const at of command.matchAll(/<</g)) if (!QUOTED_HEREDOC.test(command.slice(at.index))) return null;
  const stripped = withoutHeredocs(command).replace(/^[ \t]*#.*$/gm, '');
  const pieces = topLevelPieces(stripped);
  if (!pieces) return null;

  let push = null;
  let sawCommit = false;
  for (let i = 0; i < pieces.length; i++) {
    const read = classify(pieces[i]);
    if (!read) return null;
    if (read.kind === 'commit') sawCommit = true;
    if (read.kind !== 'push') continue;
    if (push || !sawCommit || !['start', '&&', ';'].includes(pieces[i].sep)) return null;
    push = read.git;
  }
  if (!push) return null;

  // Its own words: origin, no force, at most one refspec, to a `claude/` or `codex/` branch.
  const positionals = [];
  for (const arg of push.args) {
    if (arg.startsWith('-')) {
      if (!PUSH_FLAGS.has(arg)) return null;
    } else positionals.push(arg);
  }
  const [remote = 'origin', ...refspecs] = positionals;
  if (remote !== 'origin' || refspecs.length > 1) return null;

  const where = readPushes(commandSegments(stripped), baseCwd).find((p) => p.afterCommit);
  if (!where?.dir) return null;
  const root = ourRoot(where.dir);
  if (!root || /["$`\\]/.test(root)) return null;
  let current = '';
  try {
    current = gitOut(where.dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  } catch {
    return null;
  }
  let branch = current;
  if (refspecs.length) {
    if (refspecs[0].startsWith('+')) return null;
    const [src, dst = src] = refspecs[0].split(':');
    if (src !== 'HEAD' && src !== current && src !== `refs/heads/${current}`) return null;
    branch = (dst === 'HEAD' ? current : dst).replace(/^refs\/heads\//, '');
  }
  if (!OUR_BRANCH.test(branch)) return null;

  // Anything pending under `.claude/` goes as two commands, so C20 reads the mirror it would ship.
  try {
    const pending = gitOut(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
    if (pending.some((entry) => entry.slice(3).startsWith('.claude/') || entry.startsWith('.claude/'))) return null;
  } catch {
    return null;
  }
  if (!onPath('gitleaks')) return null;

  // Exactly one push at a command position, in the command as written AND as read, so the scan goes
  // in front of the push and nowhere else — never inside a commit message that mentions one.
  const raw = [...command.matchAll(PUSH_AT_COMMAND_POSITION)];
  if (raw.length !== 1 || [...stripped.matchAll(PUSH_AT_COMMAND_POSITION)].length !== 1) return null;
  const at = raw[0].index + raw[0][1].length + raw[0][2].length;
  const scan =
    `{ gitleaks git "${root}" "--log-opts=origin/main..HEAD" --redact --no-banner || { s=$?; ` +
    `echo "C12 - the secret scan stopped this push (gitleaks exit $s) after the commit was made. ` +
    `The commit is LOCAL only: read the finding above, then fix it with git reset --soft HEAD~1, ` +
    `or, only for a finding you judged a fixture, push again with the PHX_SECRETS_OK stand-down" >&2; false; }; } && `;
  return { command: command.slice(0, at) + scan + command.slice(at), root, branch };
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
