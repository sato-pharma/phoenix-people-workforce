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
// 🔴 AND SINCE 2026-10-23 THE REMINDER COVERS EVERY PUSH, NOT ONLY ONE THAT ADDS A TEST FILE
// (owner, choosing "warn on every push" over leaving it narrow and over refusing: the reminder
// widens, the refusal does not). A push whose commit has no recorded `check-contracts` pass gets one
// short line naming the command. It is STILL a note — the 2026-10-04 ruling *"keep the pre-push test
// as a rule, no guard"* is untouched, and the deny arm stays typecheck-only.
// A reminder with no way to be satisfied is noise, so `scripts/check-contracts.mjs` now records a
// clean full pass per commit (`scripts/lib/check-contracts-record.mjs`) and this hook reads it: commit,
// run the gates, push, and the push is silent. A pass recorded against a DIRTY tree is never written,
// so the quiet push is always one whose commit was actually proved.
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
import { isAbsolute, join, resolve } from 'node:path';

import { changedDirectory, commandSegments, parseGit, readPush } from './lib/git-command.mjs';

/** remote-check-plan.mjs `VERDICT_DIR_NAME` — tests/push-typecheck-guard.test.ts pins the two together. */
const VERDICT_DIR_NAME = 'phx-remote-check';

/** scripts/lib/check-contracts-record.mjs `CONTRACTS_DIR_NAME` — tests/push-typecheck-guard.test.ts pins the pair. */
const CONTRACTS_DIR_NAME = 'phx-check-contracts';

/** A test file of this repo. A NEW one is what makes `check-contracts` mandatory before the push. */
const TEST_FILE_RE = /^tests\/.+\.test\.tsx?$/;

/** How many added test files the note names before it stops listing them. */
const NAMED_TEST_FILES = 5;

const SHA_RE = /^[0-9a-f]{40}$/;

/** Git subcommands that move HEAD — a push chained after one sends a commit this hook cannot see yet. */
const HEAD_MOVING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'pull', 'reset', 'am', 'revert', 'checkout', 'switch']);

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
 * The `check-contracts` pass recorded for exactly this sha, or null. A record naming another commit,
 * or one written against a dirty tree (`clean !== true`), is not a pass for THIS push and is ignored.
 */
function contractsPassFor(commonDir, sha) {
  try {
    const parsed = JSON.parse(readFileSync(join(commonDir, CONTRACTS_DIR_NAME, `${sha}.json`), 'utf8'));
    return parsed && parsed.sha === sha && parsed.clean === true ? parsed : null;
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

/** Every other push: one line, the command, and why it is cheap. Informative, never a refusal. */
function contractsReminder(short, tool) {
  return (
    `BEFORE THIS PUSH (owner, 2026-10-23: warn on every push): \`node scripts/check-contracts.mjs\` — ` +
    `about 8 seconds, local, and it holds the repo-wide gates that a PR's \`static\` job would fail on. ` +
    `Nothing is recorded for ${short}.\n` +
    `Run it on the COMMIT (a dirty tree records nothing) and the next push of it is silent. ` +
    `This is a note, not a gate — the push proceeds either way, and the PR's \`validate\` + \`checks\` ` +
    `remain the verdict. Silence it for one push with ` +
    (/powershell/i.test(tool) ? '`$env:PHX_PUSH_CHECK_OFF=1; <the same command>`' : '`PHX_PUSH_CHECK_OFF=1 <the same command>`') +
    '.'
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

  // 🔴 EVERY OTHER PUSH GETS THE SHORT LINE — unless the reminder above already named the same
  // command, which would only say it twice, or this exact commit has a recorded clean pass.
  const alreadySaid = said.some((text) => text.startsWith('THE RULE'));
  if (!alreadySaid && !contractsPassFor(commonDir, sha)) said.push(contractsReminder(short, tool));

  if (!said.length) return allow();
  return note(said.join('\n\n'));
}

try {
  main();
} catch {
  process.exit(0);
}
