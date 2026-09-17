#!/usr/bin/env node
// PreToolUse(Write|Edit|NotebookEdit) guard — denies a worktree session writing into a working
// tree it does not own.
//
// WHY THIS EXISTS. CLAUDE.md has carried this line for weeks, under "Parallel sessions and
// worktrees":
//
//     A worktree session can Read/Write the PRIMARY checkout's path by absolute path with no error
//     at all. The mistake is invisible until `git status` catches it — check which tree you are in.
//
// Nothing enforced it. Every other rule in that section has a mechanism: `session-lock.mjs` warns
// when two sessions share a folder, `bash-guard.mjs` C6 denies pnpm inside a worktree,
// `worktree-exit-guard.mjs` reports unpushed commits before a removal. This one was pure
// attention — and attention is what a 4am session has least of. The failure mode is silent by
// construction: the edit succeeds, the file is correct, and it lands in the ONE folder that a
// dozen sessions share and that another session's `git reset` will wipe. The session that made the
// edit then commits its branch, pushes, and the change is simply not in it.
//
// WHY IT COVERS SIBLING WORKTREES TOO. Writing into another session's `_wt-*` is the same harm
// with a different victim: it clobbers uncommitted work that the writing session cannot see and
// will not commit. The repo has already paid for that class of mistake three times — a session
// git-detached by another session's checkout, a branch auto-deleted mid-work by a second session
// reusing its name, a swarm of sessions dropping a staged file.
//
// WHY Write|Edit ONLY, and not Bash. The documented trap is the TOOL-CALL path, because that is
// the one with no visible evidence: `Write` with an absolute path prints nothing about which tree
// it landed in. A shell redirection is at least readable in the command text, and parsing
// arbitrary shell for write targets is where false positives live — a guard that denies a command
// that works is worse than no guard, which is why `bash-guard.mjs` retired its jq rule. If shell
// writes into the primary ever become a real incident here, add the rule there, with the command
// text in hand.
//
// WHAT IT DOES NOT DO: it never touches a file, never reverts anything, and never denies a READ.
// Reading the primary from a worktree is legitimate and common — comparing against it is often the
// whole point. Only a write is denied, and only into a tree the session does not own.
//
// FAILS OPEN. Any error, any missing field, any git failure exits 0 with no output, which the
// engine reads as "no opinion". A hook bug must never block a real edit.
//
// ESCAPE HATCH: PHX_PRIMARY_GUARD_OFF=1 in the session's environment turns it off, the same shape
// as PHX_DEV_REAPER_OFF for the dev-server reaper. There is one legitimate case — the control
// tower session deliberately editing the primary — and that session is not a worktree session, so
// it never sees this guard at all.
//
//   node .claude/hooks/primary-write-guard.mjs --selftest

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/* ------------------------------------------------------------------ paths */

/** Windows is case-insensitive and mixes separators; compare one shape only. */
export function norm(p) {
  if (!p) return null;
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Is `child` the same path as `parent`, or inside it?
 *
 * The trailing separator is the point: without it `/repo-old` reads as inside `/repo`, and this
 * repo really does hold sibling folders one character apart (`_wt-ship-skill`,
 * `_wt-ship-verifier-retry`).
 */
export function insideOf(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/* ------------------------------------------------------------------ the decision */

/**
 * Which tree does `target` belong to, and may this session write there?
 *
 * ORDER IS LOAD-BEARING. A worktree can live INSIDE the primary checkout — this repo keeps
 * `.claude/worktrees/<name>` there for app-created sessions — so the session's own root is tested
 * FIRST. Testing the primary first would deny such a session every edit to its own files, which is
 * both wrong and the kind of wrong that gets a guard deleted rather than fixed.
 */
export function classify({ target, sessionRoot, primary, others = [], linked }) {
  if (!linked) return { decision: 'allow', why: 'session is not in a linked worktree' };
  if (!target) return { decision: 'allow', why: 'no target path' };
  if (!sessionRoot) return { decision: 'allow', why: 'session root unknown' };

  if (insideOf(target, sessionRoot)) return { decision: 'allow', why: 'inside this session own worktree' };

  for (const other of others) {
    if (!other || insideOf(other, sessionRoot) || insideOf(sessionRoot, other)) continue;
    if (insideOf(target, other)) {
      return { decision: 'deny', why: 'another session worktree', tree: other };
    }
  }

  if (primary && insideOf(target, primary)) {
    return { decision: 'deny', why: 'the primary checkout', tree: primary };
  }

  return { decision: 'allow', why: 'outside every working tree of this repo' };
}

/* ------------------------------------------------------------------ git */

function gitTrees(dir) {
  let gitDir = null;
  let commonDir = null;
  let toplevel = null;
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    [gitDir, commonDir, toplevel] = out.trim().split(/\r?\n/);
  } catch {
    return { linked: false, primary: null, root: null, others: [] };
  }
  if (!gitDir || !commonDir) return { linked: false, primary: null, root: null, others: [] };

  const linked = norm(gitDir) !== norm(commonDir);
  const primary = dirname(commonDir.replace(/\\/g, '/'));
  const root = toplevel ? toplevel.replace(/\\/g, '/') : null;

  // Sibling worktrees, read straight off disk rather than with a second git process: every
  // registered worktree leaves <common>/worktrees/<name>/gitdir holding the path to its .git file.
  const others = [];
  try {
    const base = join(commonDir.replace(/\\/g, '/'), 'worktrees');
    for (const entry of readdirSync(base)) {
      try {
        const pointer = readFileSync(join(base, entry, 'gitdir'), 'utf8').trim();
        if (pointer) others.push(dirname(pointer.replace(/\\/g, '/')));
      } catch {
        /* a half-removed worktree - skip it */
      }
    }
  } catch {
    /* no worktrees directory at all */
  }

  return { linked, primary, root, others };
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let failed = 0;
  const check = (label, got, want) => {
    if (got !== want) {
      failed += 1;
      console.error(`  FAIL  ${label}\n        got  ${got}\n        want ${want}`);
    }
  };

  const PRIMARY = 'F:/Phoenix Workforce/phoenix-workforce';
  const WT = 'F:/Phoenix Workforce/_wt-claude-automations';
  const SIBLING = 'F:/Phoenix Workforce/_wt-sos-bricks-map-load';
  const NESTED = `${PRIMARY}/.claude/worktrees/blissful-jemison-92a6f5`;
  const OTHER_NESTED = `${PRIMARY}/.claude/worktrees/gifted-franklin-801c25`;
  const ALL = [PRIMARY, WT, SIBLING, NESTED, OTHER_NESTED];

  const at = (sessionRoot) => (target) =>
    classify({ target, sessionRoot, primary: PRIMARY, others: ALL, linked: true }).decision;

  console.log('SELFTEST primary-write-guard:');

  // --- a normal sibling worktree session --------------------------------------
  const wt = at(WT);
  check('its own file', wt(`${WT}/src/lib/payroll/policy.ts`), 'allow');
  check('its own root file', wt(`${WT}/AGENTS.md`), 'allow');
  check('the primary root file', wt(`${PRIMARY}/AGENTS.md`), 'deny');
  check('a file deep in the primary', wt(`${PRIMARY}/src/lib/sales/office-allocation.ts`), 'deny');
  check('the primary .claude settings', wt(`${PRIMARY}/.claude/settings.json`), 'deny');
  check('another session sibling worktree', wt(`${SIBLING}/src/app/page.tsx`), 'deny');
  check('a worktree nested inside the primary', wt(`${NESTED}/src/app/page.tsx`), 'deny');

  // --- outside the repo entirely ----------------------------------------------
  check('the scratchpad', wt('C:/Users/satoh/AppData/Local/Temp/claude/x/scratchpad/note.md'), 'allow');
  check('the machine-wide hooks', wt('C:/Users/satoh/.claude/hooks/dev-server-reaper.mjs'), 'allow');
  check('the memory index', wt('C:/Users/satoh/.claude/projects/x/memory/MEMORY.md'), 'allow');
  check('a different repo', wt('F:/Other Repo/src/index.ts'), 'allow');
  check('the xlsx folder of a THIRD folder that merely starts the same', wt('F:/Phoenix Workforce/_wt-claude-automations-old/x.ts'), 'allow');

  // --- the nesting trap: a session whose worktree lives INSIDE the primary ----
  const nested = at(NESTED);
  check('nested session editing its own file', nested(`${NESTED}/src/lib/payroll/policy.ts`), 'allow');
  check('nested session editing its own root', nested(`${NESTED}/package.json`), 'allow');
  check('nested session editing the primary', nested(`${PRIMARY}/package.json`), 'deny');
  check('nested session editing the primary src', nested(`${PRIMARY}/src/app/page.tsx`), 'deny');
  check('nested session editing a SIBLING nested worktree', nested(`${OTHER_NESTED}/src/app/page.tsx`), 'deny');
  check('nested session editing a sibling _wt', nested(`${SIBLING}/x.ts`), 'deny');

  // --- Windows path shapes ----------------------------------------------------
  check('backslashes', wt('F:\\Phoenix Workforce\\phoenix-workforce\\AGENTS.md'), 'deny');
  check('a lower-case drive letter', wt('f:/phoenix workforce/phoenix-workforce/AGENTS.md'), 'deny');
  check('a trailing slash on the target', wt(`${PRIMARY}/src/`), 'deny');
  check('the primary root itself', wt(PRIMARY), 'deny');
  check('a folder whose name merely starts like the primary', wt('F:/Phoenix Workforce/phoenix-workforce-old/AGENTS.md'), 'allow');

  // --- the guard must be inert outside a worktree -----------------------------
  const primarySession = (target) =>
    classify({ target, sessionRoot: PRIMARY, primary: PRIMARY, others: ALL, linked: false }).decision;
  check('primary session editing the primary', primarySession(`${PRIMARY}/AGENTS.md`), 'allow');
  check('primary session editing a worktree', primarySession(`${WT}/AGENTS.md`), 'allow');
  check('a cloud clone (no worktrees at all)', classify({ target: '/app/src/x.ts', sessionRoot: '/app', primary: null, others: [], linked: false }).decision, 'allow');

  // --- missing data must never deny -------------------------------------------
  check('no target', classify({ target: null, sessionRoot: WT, primary: PRIMARY, others: ALL, linked: true }).decision, 'allow');
  check('no session root', classify({ target: `${PRIMARY}/AGENTS.md`, sessionRoot: null, primary: PRIMARY, others: ALL, linked: true }).decision, 'allow');
  check('no primary and no others', classify({ target: '/x/y.ts', sessionRoot: '/z', primary: null, others: [], linked: true }).decision, 'allow');

  // --- insideOf boundaries ----------------------------------------------------
  check('insideOf same path', insideOf('/a/b', '/a/b'), true);
  check('insideOf child', insideOf('/a/b/c', '/a/b'), true);
  check('insideOf sibling prefix', insideOf('/a/bc', '/a/b'), false);
  check('insideOf parent is not inside child', insideOf('/a', '/a/b'), false);
  check('insideOf null', insideOf(null, '/a'), false);

  const total = 35;
  console.log(`  ${total} cases, ${failed} failed`);
  if (failed) {
    console.error('SELFTEST FAILED');
    process.exit(1);
  }
  console.log('SELFTEST OK');
}

/* ------------------------------------------------------------------ hook entry */

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function targetOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const raw = toolInput.file_path || toolInput.notebook_path || toolInput.path || null;
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  if (process.env.PHX_PRIMARY_GUARD_OFF === '1') return;

  const payload = readStdin();
  if (!payload.trim()) return;

  let input;
  try {
    input = JSON.parse(payload);
  } catch {
    return; // unparseable stdin is not an edit to deny
  }

  const target = targetOf(input.tool_input);
  if (!target) return;

  // CLAUDE_PROJECT_DIR is the session's OWN worktree — measured in all three layouts on this
  // machine. The hook's cwd is not reliable for this: it follows whatever the last command did.
  const sessionRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { linked, primary, root, others } = gitTrees(sessionRoot);
  const verdict = classify({ target, sessionRoot: root || sessionRoot, primary, others, linked });
  if (verdict.decision !== 'deny') return;

  const own = root || sessionRoot;
  const reason =
    `This session is working in ${own}, and ${target} is in ${verdict.tree} — ` +
    `${verdict.why}. A worktree session can write there with no error at all, which is exactly why ` +
    'this is denied: the edit would succeed, land in a folder this branch will never commit, and ' +
    "sit there until another session's checkout or reset wipes it.\n\n" +
    `Write the same change under ${own} instead. If it genuinely belongs in the other tree, say so ` +
    'to the owner and let that tree\'s own session make it — or set PHX_PRIMARY_GUARD_OFF=1 if he ' +
    'tells you to write across trees.';

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  process.exit(0); // fail open, always
}
