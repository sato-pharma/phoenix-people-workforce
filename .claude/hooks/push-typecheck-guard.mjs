#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) — run the typecheck ON THE CI BOX before a `git push` leaves this machine.
//
// WHY THIS EXISTS. `buggy_code` is the top friction category in the owner's own usage report, and the
// worst of it is a type error that only shows up AFTER the push: the PR's `checks` job goes red, costs a
// full CI round (~14 billable minutes, twice with the `main` run) and the fix costs another. A local
// `tsc` is not the answer — it needs 4.0-4.5 GB and `mem-watchdog.ps1` reaps it (bash-guard C8 refuses
// one outright). `node scripts/remote-check.mjs typecheck` is: it ships the committed sha to the preview
// box and answers in ~2 minutes without touching this laptop's RAM or billing a single Actions minute.
// This hook makes running it the push's own first step instead of something a session must remember.
//
// 🔴 THIS IS NOT THE RETIRED PRE-PUSH GIT HOOK, AND NOT A LOCAL VALIDATION. AGENTS.md §7 retired
// `check:harden` and `.git/hooks/pre-push` on 2026-08-18 because they ran HEAVY WORK ON THIS LAPTOP. This
// one runs nothing heavy here, lives in the Claude hooks (a push typed in a plain terminal never sees it),
// and exists because the owner asked for it by name on 2026-10-04 ("add a remote typecheck before every
// push, in a worktree"). Do not read the retirement as a reason to remove it.
//
// WHAT IT DECIDES
//   - It acts on a `git push` that sends the CHECKED-OUT commit. A push of another ref, a delete, a tag,
//     a dry run, `--all`/`--mirror`, a push to a non-branch ref (refs/backups/…) or one that sends nothing
//     new (origin already holds this sha) is none of its business.
//   - It skips a push that changes nothing a typechecker reads: it diffs `origin/main...HEAD` and runs only
//     if some file is .ts/.tsx/.js/.mjs/.json or the pnpm manifests. CI skips the same way for a
//     docs-only change, so a migration-only or docs-only push is not made to wait two minutes for nothing.
//   - It remembers a PASS per commit in `<git-common-dir>/phx-remote-typecheck/<sha>`, so pushing the same
//     commit twice (an update-branch, a retry, a second remote) costs nothing. The directory is shared by
//     every worktree and is never tracked.
//   - It DENIES only on a verdict: the box ran the typecheck and it FAILED. Anything else — no SSH key, the
//     box unreachable, a run whose tree moved (exit 3), an install failure, a timeout — ALLOWS and says so,
//     because the PR's `checks` job is still the real gate and a guard that blocks every push when the box
//     is down is a guard that gets switched off within the hour (bash-guard C12 makes the same call).
//
// 🔴 A CHAINED `git commit && git push` CANNOT BE CHECKED, SO IT IS REFUSED. A PreToolUse hook runs before
// the WHOLE command, so at that moment HEAD is the commit BEFORE the one about to be pushed — checking it
// would prove nothing about what ships. A push preceded in the same command by a commit, merge, rebase,
// cherry-pick, pull, reset, am, revert, checkout or switch is refused with the instruction to run those
// first as their own command. That is the one cost of "before every push", and the deny says so.
//
// 🔴 IT SENDS THE COMMIT, NOT THE WORKING TREE — `remote-check.mjs` says so itself and prints any
// uncommitted file it ignored. Stage nothing here and commit nothing here; this hook only reads.
//
// Stand-downs: `PHX_PUSH_CHECK_OFF=1 <cmd>` (`$env:PHX_PUSH_CHECK_OFF=1; <cmd>` in PowerShell) for one
// push the owner told you to make regardless. `PHX_PUSH_CHECK_TIMEOUT_MS` shortens the wait (the tests use
// it); the default 7 minutes sits inside the hook's own 8-minute timeout in .claude/settings.json.
//
// FAILS OPEN: any parse or logic error exits 0 with no decision. A hook bug must never block a real push.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

const SCRIPT_RELATIVE = join('scripts', 'remote-check.mjs');
const RUN_TIMEOUT_MS = Number(process.env.PHX_PUSH_CHECK_TIMEOUT_MS) || 7 * 60 * 1000;
const CACHE_DIR_NAME = 'phx-remote-typecheck';
const CACHE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** What a typechecker (or the install in front of it) can read — see the header. */
const TYPECHECK_INPUT = /\.(?:[cm]?[jt]sx?|json)$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^\.npmrc$/i;

/** Git subcommands that move HEAD — a push chained after one cannot be checked by a hook. */
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
 * Does any file this push would carry hold something a typechecker reads? `withWorkingTree` adds what is
 * staged, modified or untracked, for a chained command whose commit does not exist yet. If the diff cannot
 * be read the answer is YES — the safe side is to run the check.
 */
function typecheckRelevant(root, withWorkingTree) {
  try {
    const base = gitOut(root, ['merge-base', 'origin/main', 'HEAD']);
    const files = gitOut(root, ['diff', '--name-only', base, 'HEAD']).split(/\r?\n/).filter(Boolean);
    if (withWorkingTree) {
      for (const line of execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      }).split(/\r?\n/)) {
        if (line.length < 4) continue;
        files.push(line.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
      }
    }
    return files.some((file) => TYPECHECK_INPUT.test(file));
  } catch {
    return true;
  }
}

/** The lines between the typecheck's own banners — the errors tsc printed, nothing else. */
function typecheckErrors(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const start = lines.findIndex((line) => /^=== typecheck ===/.test(line));
  const end = lines.findIndex((line) => /^--- typecheck FAIL in /.test(line));
  const body = start >= 0 ? lines.slice(start + 1, end >= 0 ? end : undefined) : lines;
  return body.filter((line) => line.trim()).slice(-60).join('\n');
}

function remember(cacheDir, sha) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, sha), `${new Date().toISOString()}\n`);
    for (const name of readdirSync(cacheDir)) {
      const file = join(cacheDir, name);
      if (Date.now() - statSync(file).mtimeMs > CACHE_KEEP_MS) unlinkSync(file);
    }
  } catch {
    // an unwritable cache only means the next push of this commit re-runs the check
  }
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

  // Find the `git push`, and what ran before it in the same command.
  const segments = commandSegments(withoutHereStringBodies(withoutHeredocBodies(command)));
  let dir = [input?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()].find((c) => c && existsSync(String(c)));
  if (!dir) return allow();
  dir = String(dir);
  let push = null;
  const movedHead = [];
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
    if (HEAD_MOVING.has(git.sub)) movedHead.push(git.sub);
  }
  if (!push) return allow();
  if (push.dir) {
    const target = nativePath(push.dir);
    dir = isAbsolute(target) ? target : resolve(dir, target);
  }

  const read = readPush(push.args);
  if (read.skip) return allow();

  // This repository only — the hook is project-level, but a checkout without the script has nothing to run.
  let root;
  try {
    root = gitOut(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return allow();
  }
  const script = join(root, SCRIPT_RELATIVE);
  if (!existsSync(script)) return allow();

  let current = '';
  try {
    current = gitOut(root, ['branch', '--show-current']);
  } catch {
    // detached or unreadable — whatIsPushed handles an empty branch
  }
  const pushed = whatIsPushed(read.refspecs, current);
  if (!pushed.sends) return allow();

  if (movedHead.length > 0) {
    // The same relevance test, over what the commit WILL hold: a chained docs-only commit is not worth a split.
    if (!typecheckRelevant(root, true)) return allow();
    return deny(
      `PUSH REFUSED — this one command runs \`git ${movedHead[0]}\` and THEN \`git push\`, so the typecheck on the CI box ` +
        `cannot see the commit the push would send: a PreToolUse hook runs before the whole command, when HEAD is still ` +
        `the commit BEFORE this one.\n\n` +
        `Run the \`git ${movedHead.join('\`, \`git ')}\` as a command of its own, then push in the next command — the ` +
        `check runs on that push and answers in about two minutes without touching this laptop's RAM.\n\n` +
        `If the owner told you to push regardless, stand it down for this one push:\n  ` +
        (/powershell/i.test(tool) ? '$env:PHX_PUSH_CHECK_OFF=1; <the same command>' : 'PHX_PUSH_CHECK_OFF=1 <the same command>'),
    );
  }

  let sha;
  let commonDir;
  try {
    sha = gitOut(root, ['rev-parse', 'HEAD']);
    commonDir = gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    return allow();
  }

  // Nothing new to send, or already proved on the box.
  try {
    const remoteTip = gitOut(root, ['rev-parse', '--verify', '-q', `refs/remotes/${read.remote}/${pushed.branch}`]);
    if (remoteTip === sha) return allow();
  } catch {
    // no remote-tracking ref yet — this is a first push of the branch
  }
  const cacheDir = join(commonDir, CACHE_DIR_NAME);
  if (existsSync(join(cacheDir, sha))) return allow();

  // A change no typechecker reads does not need one. If the diff cannot be read, check anyway.
  if (!typecheckRelevant(root, false)) return allow();

  const started = Date.now();
  const run = spawnSync(process.execPath, [script, 'typecheck'], {
    cwd: root,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const short = sha.slice(0, 9);

  if (run.status === 0 && /^remote-check: PASS/m.test(output)) {
    remember(cacheDir, sha);
    return note(`Remote typecheck PASSED on the CI box for ${short} (${seconds}s) — the push may proceed.`);
  }

  if (run.status === 1 && /^remote-check: FAIL/m.test(output) && /^--- typecheck FAIL in /m.test(stripAnsi(output))) {
    return deny(
      `PUSH REFUSED — the typecheck on the CI box FAILED for ${short} (${seconds}s). This is the same \`tsc\` the PR's ` +
        `\`checks\` job would run, and pushing now would only buy a red PR and a second CI round.\n\n` +
        `${typecheckErrors(output)}\n\n` +
        `Fix it, commit, and push again — the check re-runs for the new commit, and a PASS is remembered per commit, so ` +
        `an unchanged one is never re-run. Re-run it by hand any time: node scripts/remote-check.mjs typecheck\n\n` +
        `If the owner told you to push regardless, stand it down for this one push:\n  ` +
        (/powershell/i.test(tool) ? '$env:PHX_PUSH_CHECK_OFF=1; <the same command>' : 'PHX_PUSH_CHECK_OFF=1 <the same command>'),
    );
  }

  // No verdict: say why, and let the push through — the PR's `checks` job is still the gate.
  const why =
    run.error?.code === 'ETIMEDOUT'
      ? `it did not finish within ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes`
      : run.status === 3
        ? "the box's tree changed under the run (NO VERDICT)"
        : run.status === 2
          ? 'the box could not be reached (see the SSH note below)'
          : `it exited ${run.status ?? 'abnormally'} without a typecheck verdict`;
  return note(
    `The remote typecheck gave NO VERDICT for ${short} — ${why} — so this push was NOT checked before it left. The PR's ` +
      `\`checks\` job will still run the typecheck. Last output:\n${stripAnsi(output).trim().split(/\r?\n/).slice(-8).join('\n')}`,
  );
}

try {
  main();
} catch {
  process.exit(0);
}
