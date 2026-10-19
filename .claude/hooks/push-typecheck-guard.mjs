#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) — before a `git push`, REUSE what remote-check already proved about the
// pushed commit. It starts nothing and waits for nothing. (The CI box remote-check once ran on is retired,
// 2026-10-19: remote-check now reads the PR's GitHub Actions run, so a record exists only for a commit that
// was already pushed — which is why a push adding a test file is pointed at `check-contracts` instead.)
//
// 🔴 WHAT CHANGED ON 2026-10-08, AND WHY (owner, performance recovery: *"the push guard must not start
// a remote check that blocks a normal push. Previously completed verification for the exact commit SHA
// may be reused, but the PR's required GitHub CI checks must remain the authoritative validation
// gate"*). From 2026-10-04 this hook RAN `remote-check typecheck` on every push and held the push for up
// to seven minutes. Measured from the session transcripts: push wall time went from a 7s median to a
// 146s p75, ~1.3 session-hours a day were spent inside this hook, and on a busy box it answered NO
// VERDICT anyway — so its protection depended on luck while its cost did not. The PR's own `checks`
// job runs the same `tsc` on the same commit and is the gate that actually blocks a merge.
//
// WHAT IT DOES NOW
//   - It reads `<git-common-dir>/phx-remote-check/<sha>.json`, the per-stage record remote-check writes
//     when a run ENDS IN A VERDICT (scripts/remote-check-plan.mjs, "THE VERDICT RECORD"). The directory
//     is shared by every worktree and never tracked.
//   - A recorded typecheck FAIL for the EXACT commit being pushed → DENY, with tsc's own lines. Pushing a
//     commit already proved broken only buys a red PR and a second CI round.
//   - A recorded PASS → a one-line note. Nothing recorded → allow, silently and at once.
//   - It never reads a record for any other sha, so an older run's verdict can never speak for this one.
//
// 🔴 THE NEW-TEST-FILE REMINDER (owner, 2026-10-12: *"make remote-check test mandatory before a push that
// adds a test file"*) IS A NOTE, NEVER A DENY. A push whose commits ADD a `tests/**.test.ts(x)` file and
// have no recorded `test` PASS for that exact sha gets the rule said back to it, naming the files and the
// command. It still allows: on 2026-10-04 the owner was offered a hook that REFUSES a push over the suite
// and answered *"keep the pre-push test as a rule, no guard"* — that ruling stands until he lifts it in
// his own words, so this hook may remind and may not refuse. Measured 12 Oct 2026: 4 of 25 red PR runs
// that day were the comment-strip ratchet firing on a newly added test file. Since 2026-10-19 the command
// the reminder names is `node scripts/check-contracts.mjs` (about 8s, local, catches that ratchet), because
// the suite runs on GitHub and GitHub can only run a commit origin already holds.
// Account: `docs/testing.md`, "Before every push".
//
// WHAT IT DECIDES ABOUT (unchanged): a `git push` that sends the CHECKED-OUT commit. A push of another
// ref, a delete, a tag, a dry run, `--all`/`--mirror`, a push to a non-branch ref or one that sends
// nothing new is none of its business. A push chained after a commit, merge, rebase, reset or checkout
// in the same command is simply allowed: at hook time HEAD is not yet the commit that will be pushed,
// so blocking on HEAD's record would block the wrong commit, and a brand-new commit has none anyway.
//
// Stand-down: `PHX_PUSH_CHECK_OFF=1 <cmd>` (`$env:PHX_PUSH_CHECK_OFF=1; <cmd>` in PowerShell) for one
// push the owner told you to make regardless of a recorded FAIL.
//
// FAILS OPEN: any parse, read or logic error exits 0 with no decision. A hook bug must never block a push.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** remote-check-plan.mjs `VERDICT_DIR_NAME` — tests/push-typecheck-guard.test.ts pins the two together. */
const VERDICT_DIR_NAME = 'phx-remote-check';

/** A test file of this repo. A NEW one is what makes `check-contracts` mandatory before the push. */
const TEST_FILE_RE = /^tests\/.+\.test\.tsx?$/;

/** How many added test files the note names before it stops listing them. */
const NAMED_TEST_FILES = 5;

const SHA_RE = /^[0-9a-f]{40}$/;

/** Git subcommands that move HEAD — a push chained after one sends a commit this hook cannot see yet. */
const HEAD_MOVING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'pull', 'reset', 'am', 'revert', 'checkout', 'switch']);

/** Push flags that take their value as the NEXT token (the `--flag=value` spelling carries it inline). */
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** Global git options that take their value as the NEXT token. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const OFF_IN_COMMAND = /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_PUSH_CHECK_OFF\s*=\s*['"]?1['"]?(?![\w.])/i;

function emit(output) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }));
  process.exit(0);
}

const deny = (reason) => emit({ permissionDecision: 'deny', permissionDecisionReason: reason });
const note = (text) => emit({ additionalContext: text });
const allow = () => process.exit(0);

const gitOut = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();

/** Heredoc bodies are data, not commands — a commit message quoting `git push` runs nothing. */
const withoutHeredocBodies = (text) =>
  text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[ \t]*\2[ \t]*\r?$/gm, '');

/** So is a PowerShell here-string's — `@'`…`'@` is how a commit message is written from that tool. */
const withoutHereStringBodies = (text) => text.replace(/@(["'])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, "''");

/** The command split at its command positions, but never inside a quoted string. */
function commandSegments(text) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if ('\n|;&('.includes(ch)) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

/** Wrappers that still run what they carry: `cmd /c`, a shell's `-c`, `VAR=value`, a leading quote. */
const LAUNCH_WRAPPERS = [
  /^cmd(?:\.exe)?\s+\/[ck]\s+/i,
  /^(?:powershell|pwsh|bash|sh)(?:\.exe)?\s+(?:-{1,2}[\w-]+\s+)*/i,
  /^(?:call|exec|nohup|env)\s+/i,
  /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/,
  /^["']/,
];

function unwrapped(segment) {
  let text = segment.trim();
  for (let pass = 0; pass < 8; pass++) {
    const before = text;
    for (const wrapper of LAUNCH_WRAPPERS) text = text.replace(wrapper, '').trim();
    if (text === before) break;
  }
  return text;
}

/** argv for one segment, QUOTE-AWARE — every path on this machine has a space in it. */
function argvTokens(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/** `2>&1`, `> file`, `2> file` are not arguments of the command they trail. */
function withoutRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d*>>?$/.test(token)) {
      i += 1; // the file the redirect writes to
      continue;
    }
    if (/^\d*>>?(?:&\d+|\S+)$/.test(token) || /^<\S*$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * One segment read as a git invocation: `{ sub, args, dir }`, or null when it is not git. `dir` is the
 * `-C <dir>` target. Global options between `git` and the subcommand are skipped.
 */
function parseGit(segment) {
  const tokens = withoutRedirects(argvTokens(unwrapped(segment)));
  if (!tokens.length || !/^git(?:\.exe)?$/i.test(basename(tokens[0].replace(/\\/g, '/')))) return null;
  let dir = null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (GIT_VALUE_OPTIONS.has(tokens[i])) {
      if (tokens[i] === '-C') dir = tokens[i + 1] ?? null;
      i += 2;
    } else {
      i += 1;
    }
  }
  return { sub: tokens[i] ?? '', args: tokens.slice(i + 1), dir };
}

/** `cd <dir>` / `Set-Location <dir>` / `pushd <dir>` — the folder a LATER segment of the command runs in. */
function changedDirectory(segment) {
  const tokens = argvTokens(unwrapped(segment));
  if (!tokens.length || !/^(?:cd|chdir|pushd|set-location|sl)$/i.test(tokens[0])) return null;
  const target = tokens.slice(1).find((t) => !/^\/d$/i.test(t) && !/^-(?:literalpath|path)$/i.test(t));
  return target && target !== '-' ? target : null;
}

/**
 * A `git push`'s own words: flags that end the matter (dry run, delete, mirror…), the remote, and the
 * refspecs. `skip` is why this push is none of the hook's business, or null.
 */
function readPush(args) {
  let skip = null;
  let sawTags = false;
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const name = token.split('=')[0];
      if (name === '--dry-run' || name === '--help') skip = 'a dry run or help request';
      else if (name === '--delete') skip = 'a branch delete';
      else if (name === '--all' || name === '--mirror') skip = `${name} (it pushes more than the checked-out commit)`;
      else if (name === '--tags') sawTags = true;
      if (PUSH_VALUE_FLAGS.has(name) && !token.includes('=')) i += 1;
    } else if (token.startsWith('-') && token.length > 1) {
      if (PUSH_VALUE_FLAGS.has(token)) i += 1;
      else if (/^-[A-Za-z]*n[A-Za-z]*$/.test(token)) skip = 'a dry run';
      else if (/^-[A-Za-z]*d[A-Za-z]*$/.test(token)) skip = 'a branch delete';
      else if (/^-[A-Za-z]*h[A-Za-z]*$/.test(token)) skip = 'a help request';
    } else {
      positionals.push(token);
    }
  }
  const [remote = 'origin', ...refspecs] = positionals;
  if (!skip && sawTags && refspecs.length === 0) skip = 'a tag push';
  return { skip, remote, refspecs };
}

/**
 * Does this push send the CHECKED-OUT commit, and to which branch name? `{ sends: true, branch }`, or
 * `{ sends: false, why }`. Only a ref this checkout's HEAD stands for can be proved by a check of HEAD.
 */
function whatIsPushed(refspecs, current) {
  if (refspecs.length === 0) {
    return current ? { sends: true, branch: current } : { sends: false, why: 'a push from a detached HEAD with no refspec' };
  }
  let why = 'it names a ref other than the checked-out commit';
  for (const raw of refspecs) {
    const spec = raw.replace(/^\+/, '');
    if (spec.startsWith(':')) {
      why = 'a branch delete';
      continue;
    }
    const [src, dst = src] = spec.split(':');
    if (dst.startsWith('refs/') && !dst.startsWith('refs/heads/')) {
      why = `a push to ${dst}, which is not a branch`;
      continue;
    }
    if (src === 'HEAD' || (current && (src === current || src === `refs/heads/${current}`))) {
      // `git push origin HEAD` names no destination, so the branch it lands on is the checked-out one.
      const branch = dst === 'HEAD' ? current : dst.replace(/^refs\/heads\//, '');
      return { sends: true, branch: branch || current };
    }
  }
  return { sends: false, why };
}

const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '');

/** Git Bash writes `/f/Phoenix Workforce/x`; node on Windows only opens `F:/Phoenix Workforce/x`. */
const nativePath = (value) =>
  process.platform === 'win32' ? String(value).replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive) => `${drive.toUpperCase()}:`) : String(value);

/**
 * The verdict remote-check recorded for exactly this sha, or null. Never throws — an unreadable or
 * malformed record is the same as none, which allows the push.
 */
function recordFor(commonDir, sha) {
  try {
    const parsed = JSON.parse(readFileSync(join(commonDir, VERDICT_DIR_NAME, `${sha}.json`), 'utf8'));
    if (!parsed || parsed.sha !== sha || typeof parsed.stages !== 'object' || parsed.stages === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The commit this push would land on, read so the diff covers only what is NEW to the remote. A branch
 * the remote already knows → its tracking ref; a first push → the merge base with the remote's default
 * branch. `null` when git can answer neither, which says nothing and so reminds of nothing.
 */
function pushBase(root, remote, branch, sha) {
  const resolveRef = (ref) => {
    try {
      return gitOut(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    } catch {
      return null;
    }
  };
  const tracking = resolveRef(`refs/remotes/${remote}/${branch}`);
  const defaults = [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`];
  const candidate = tracking ?? defaults.map(resolveRef).find(Boolean) ?? null;
  if (!candidate) return null;
  // A rebase or a force-push moves the tracking ref off this history, so ask for the shared ancestor.
  try {
    return gitOut(root, ['merge-base', candidate, sha]);
  } catch {
    return null;
  }
}

/** The `tests/**.test.ts(x)` files this push ADDS, sorted. Empty when it adds none, or git cannot say. */
function addedTestFiles(root, remote, branch, sha) {
  const base = pushBase(root, remote, branch, sha);
  if (!base || base === sha) return [];
  try {
    return gitOut(root, ['diff', '--name-only', '--diff-filter=A', base, sha])
      .split('\n')
      .map((line) => line.trim())
      .filter((path) => TEST_FILE_RE.test(path))
      .sort();
  } catch {
    return [];
  }
}

/** The rule said back, naming the files and the command — informative, never a refusal. */
function newTestFileReminder(added, short, recorded) {
  const listed = added.slice(0, NAMED_TEST_FILES).map((path) => `  ${path}`);
  if (added.length > NAMED_TEST_FILES) listed.push(`  …and ${added.length - NAMED_TEST_FILES} more`);
  return (
    `THE RULE (owner, 2026-10-12; the CI box is retired, 2026-10-19): a push that ADDS a test file runs ` +
    `\`node scripts/check-contracts.mjs\` FIRST — about 8 seconds, nothing heavy, and it holds the repo-wide ` +
    `gates a newly added test file trips. The suite itself runs in the PR's three parallel \`unit\` jobs ` +
    `because GitHub can only run a commit origin already holds, so a pre-push suite run is no longer possible.\n` +
    `This push adds ${added.length} test file${added.length === 1 ? '' : 's'} and ${recorded} for ${short}:\n` +
    `${listed.join('\n')}\n` +
    `On 12 Oct 2026 four red PR runs were one repo-wide ratchet firing on a newly added test file — ` +
    `\`check-contracts\` finds that one before the push. The PR's \`validate\` + \`checks\` are still the gate.`
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return allow();
  }
  const tool = String(input?.tool_name ?? '');
  if (!/^(?:bash|powershell)$/i.test(tool)) return allow();
  const command = String(input?.tool_input?.command ?? '');
  if (!/\bpush\b/.test(command)) return allow();
  if (process.env.PHX_PUSH_CHECK_OFF === '1' || OFF_IN_COMMAND.test(command)) return allow();

  // Find the `git push`, following any `cd` in front of it.
  const segments = commandSegments(withoutHereStringBodies(withoutHeredocBodies(command)));
  let dir = [input?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()].find((c) => c && existsSync(String(c)));
  if (!dir) return allow();
  dir = String(dir);
  let push = null;
  for (const segment of segments) {
    const moved = changedDirectory(segment);
    if (moved) {
      const target = nativePath(moved);
      const next = isAbsolute(target) ? target : resolve(dir, target);
      if (!existsSync(next)) return allow();
      dir = next;
      continue;
    }
    const git = parseGit(segment);
    if (!git) continue;
    if (git.sub === 'push') {
      push = git;
      break;
    }
    // A HEAD-moving command earlier in the SAME command means the commit pushed is not today's HEAD,
    // so today's HEAD's record says nothing about it — allow rather than block on the wrong sha.
    if (HEAD_MOVING.has(git.sub)) return allow();
  }
  if (!push) return allow();
  if (push.dir) {
    const target = nativePath(push.dir);
    dir = isAbsolute(target) ? target : resolve(dir, target);
  }

  const read = readPush(push.args);
  if (read.skip) return allow();

  let root;
  let current = '';
  let sha;
  let commonDir;
  try {
    root = gitOut(dir, ['rev-parse', '--show-toplevel']);
    try {
      current = gitOut(root, ['branch', '--show-current']);
    } catch {
      // detached or unreadable — whatIsPushed handles an empty branch
    }
    sha = gitOut(root, ['rev-parse', 'HEAD']);
    commonDir = gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    return allow();
  }
  if (!SHA_RE.test(sha)) return allow();
  const pushed = whatIsPushed(read.refspecs, current);
  if (!pushed.sends) return allow();

  // Nothing new to send: origin already holds this commit, so there is nothing to stop.
  try {
    if (gitOut(root, ['rev-parse', '--verify', '-q', `refs/remotes/${read.remote}/${pushed.branch}`]) === sha) return allow();
  } catch (e) {
    if (e?.[Symbol.for('phx.hook-exit')]) throw e; // the allow above ended this hook (hook-dispatch.mjs)
    // no remote-tracking ref yet — a first push of the branch
  }

  const record = recordFor(commonDir, sha);
  const short = sha.slice(0, 9);
  const typecheck = record?.stages?.typecheck;

  if (typecheck?.verdict === 'FAIL') {
    const excerpt = typeof typecheck.excerpt === 'string' && typecheck.excerpt.trim() ? `\n\n${stripAnsi(typecheck.excerpt)}` : '';
    return deny(
      `PUSH REFUSED — remote-check already ran the typecheck on this exact commit (${short}) and it FAILED ` +
        `(${typecheck.source ?? 'recorded'}, ${typecheck.at ?? 'earlier'}). The PR's \`checks\` job runs the same \`tsc\`, ` +
        `so pushing it now only buys a red PR and a second CI round.${excerpt}\n\n` +
        `Fix it and commit — a new commit has no recorded FAIL, so its push goes straight through.\n\n` +
        `If the owner told you to push regardless, stand it down for this one push:\n  ` +
        (/powershell/i.test(tool) ? '$env:PHX_PUSH_CHECK_OFF=1; <the same command>' : 'PHX_PUSH_CHECK_OFF=1 <the same command>'),
    );
  }

  const stages = Object.entries(record?.stages ?? {});
  const passed = stages.filter(([, v]) => v && v.verdict === 'PASS').map(([name]) => name);
  const failed = stages.filter(([, v]) => v && v.verdict === 'FAIL').map(([name]) => name);

  const said = [];
  if (passed.length || failed.length) {
    said.push(
      `remote-check already has a verdict for ${short}: ` +
        [passed.length ? `PASS ${passed.join(', ')}` : '', failed.length ? `FAIL ${failed.join(', ')}` : ''].filter(Boolean).join('; ') +
        ` — reused, nothing was re-run. The PR's \`validate\` + \`checks\` remain the merge gate.`,
    );
  }

  // The suite verdict this push needs, and the reminder when it is not there. A recorded test PASS is
  // the rule satisfied, so it says nothing further; a recorded FAIL is named as what it is.
  const testVerdict = record?.stages?.test?.verdict;
  if (testVerdict !== 'PASS') {
    const added = addedTestFiles(root, read.remote, pushed.branch, sha);
    if (added.length) {
      said.push(newTestFileReminder(added, short, testVerdict === 'FAIL' ? 'the record holds `test` FAIL' : 'no `test` verdict is recorded'));
    }
  }

  if (!said.length) return allow();
  return note(said.join('\n\n'));
}

try {
  main();
} catch {
  process.exit(0);
}
