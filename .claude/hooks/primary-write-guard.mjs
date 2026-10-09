#!/usr/bin/env node
// PreToolUse(Write|Edit|NotebookEdit) guard — denies a worktree session writing into a working
// tree it does not own. It owns its own worktree, and a worktree it created with
// `node scripts/new-session.mjs` that no other session is working in.
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
// A WORKTREE THIS SESSION CREATED IS ITS OWN. "Own" used to mean CLAUDE_PROJECT_DIR alone, and a
// desktop-app session is pinned to the `.claude/worktrees/<name>` folder it started in, so that
// never moves. But AGENTS.md §5 sends a session to do its work in a fresh `_wt-<task>` made by
// `node scripts/new-session.mjs <task>` — and until 2026-09-18 this guard denied Edit and Write on
// every file of the worktree the session had just made, as "another session worktree". The only
// way through was a Bash write, which this guard deliberately does not read; the session behind
// #3987 made its edit exactly that way. A guard that forces the unguarded path is being eroded.
//
// So new-session.mjs now CLAIMS the worktree it creates: it writes `phx-session-owner.json`, holding
// the creating session's id, into that worktree's git ADMIN folder, `<common .git>/worktrees/<name>/`.
// The id is CLAUDE_CODE_SESSION_ID in the script's environment — measured 2026-09-18 to be the value
// this hook receives as `session_id` and session-lock.mjs stores in every lock. CLAUDE_PROJECT_DIR is
// NOT in a Bash child's environment (only hooks get it), so a claim cannot be keyed on the folder.
//
// The admin folder, not the worktree, on purpose: nothing there can be staged, committed or copied
// into another tree, it needs no .gitignore line, and `git worktree remove`/`prune` delete it with
// the registration — a claim cannot outlive its folder or attach to a new folder reusing the name.
//
// A claim opens ONE tree to ONE session, and only while nobody else is working in it:
//   - the payload's `session_id` must equal the claim's; a payload without one matches nothing;
//   - a LIVE `.claude/session.lock` in that tree naming ANOTHER session beats the claim — the tree is
//     then that session's own folder. Live is session-lock.mjs's rule: the lock's AGE, at most two
//     hours since its last refresh;
//   - the primary checkout can never be claimed;
//   - the DEEPEST registered tree holding the target decides, so a worktree nested inside a claimed
//     one keeps its own answer.
// Claims follow the session id, not the folder: a new session in the same folder, or anything that
// gives this one a new id, matches none of them. A worktree made before this change, from a plain
// terminal, or by the desktop app carries no claim and stays denied exactly as before.
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
// engine reads as "no opinion". A hook bug must never block a real edit. A claim or a lock that
// cannot be read is not an error, though — it is simply absent: an unreadable claim leaves its tree
// denied, and an unreadable lock is no lock, exactly as session-lock.mjs reads one.
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

import { gitLayout } from '../../scripts/lib/git-layout.mjs';

/** The claim `scripts/new-session.mjs` writes into the git admin folder of a worktree it creates. */
export const CLAIM_FILE = 'phx-session-owner.json';

/** session-lock.mjs's STALE_MS: a lock not refreshed for longer than this belongs to nobody. */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

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

/* ------------------------------------------------------------------ claims and locks */

/** A session id as a comparable string: '' for anything that is not a non-blank string. */
function idOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The session a claim names, or null for anything that is not a well-formed claim. */
export function claimOwner(text) {
  try {
    return idOf(JSON.parse(text)?.sessionId) || null;
  } catch {
    return null;
  }
}

/**
 * The session holding a LIVE lock, or null. Live is session-lock.mjs's own rule: the age of
 * `refreshedAt` (else `startedAt`) is finite and not over two hours. The lock's pid is never
 * consulted — it names the hook's own short-lived shell, so it proves nothing either way.
 */
export function liveLockHolder(text, now = Date.now()) {
  try {
    const lock = JSON.parse(text);
    const holder = idOf(lock?.sessionId);
    const ageMs = now - Date.parse(lock?.refreshedAt || lock?.startedAt || '');
    return holder && Number.isFinite(ageMs) && ageMs <= LOCK_STALE_MS ? holder : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the decision */

/**
 * Which tree does `target` belong to, and may this session write there?
 *
 * ORDER IS LOAD-BEARING. A worktree can live INSIDE the primary checkout — this repo keeps
 * `.claude/worktrees/<name>` there for app-created sessions — so the session's own root is tested
 * FIRST. Testing the primary first would deny such a session every edit to its own files, which is
 * both wrong and the kind of wrong that gets a guard deleted rather than fixed.
 *
 * `others` lists every registered worktree, as a bare path or as `{ path, claimedBy, lockedBy }`:
 * the session its new-session.mjs claim names, and the session holding a live lock in it. A bare
 * path has neither, which is exactly the answer this guard gave before claims existed.
 */
export function classify({ target, sessionRoot, sessionId, primary, others = [], linked }) {
  if (!linked) return { decision: 'allow', why: 'session is not in a linked worktree' };
  if (!target) return { decision: 'allow', why: 'no target path' };
  if (!sessionRoot) return { decision: 'allow', why: 'session root unknown' };

  if (insideOf(target, sessionRoot)) return { decision: 'allow', why: 'inside this session own worktree' };

  // The DEEPEST registered tree holding the target decides. Worktrees can nest, and a folder inside
  // a claimed worktree must never borrow that worktree's claim.
  let hit = null;
  for (const entry of others) {
    const tree = typeof entry === 'string' ? { path: entry } : entry;
    const other = tree?.path;
    if (!other || insideOf(other, sessionRoot) || insideOf(sessionRoot, other)) continue;
    if (primary && norm(other) === norm(primary)) continue; // judged below, and never claimable
    if (insideOf(target, other) && (!hit || norm(other).length > norm(hit.path).length)) hit = tree;
  }

  if (hit) {
    const me = idOf(sessionId);
    const creator = idOf(hit.claimedBy);
    const holder = idOf(hit.lockedBy);
    if (!me || creator !== me) {
      const why = creator ? 'a worktree another session created' : 'another session worktree';
      return { decision: 'deny', why, tree: hit.path };
    }
    if (holder && holder !== me) {
      const why = 'a worktree this session created, but another session is working in it now';
      return { decision: 'deny', why, tree: hit.path };
    }
    return { decision: 'allow', why: 'a worktree this session created', tree: hit.path };
  }

  if (primary && insideOf(target, primary)) {
    return { decision: 'deny', why: 'the primary checkout', tree: primary };
  }

  return { decision: 'allow', why: 'outside every working tree of this repo' };
}

/* ------------------------------------------------------------------ git */

/** A small file's text, or null when it is missing or unreadable — absence, never an error. */
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function gitTrees(dir) {
  let gitDir = null;
  let commonDir = null;
  let toplevel = null;
  // 2026-10-09 (hook speed fixes): read the layout off disk first. This hook runs on EVERY
  // Write/Edit/NotebookEdit, and the `git rev-parse` below cost ~75 ms of process start-up on each
  // one — more inside a busy session. gitLayout() reads the same `.git` folder / `gitdir:` file /
  // `commondir` pointer git reads, and answers null (so git still decides) whenever it cannot.
  const layout = gitLayout(dir);
  if (layout) {
    ({ gitDir, commonDir, toplevel } = layout);
  } else {
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
  }
  if (!gitDir || !commonDir) return { linked: false, primary: null, root: null, others: [] };

  const linked = norm(gitDir) !== norm(commonDir);
  const primary = dirname(commonDir.replace(/\\/g, '/'));
  const root = toplevel ? toplevel.replace(/\\/g, '/') : null;

  // Sibling worktrees, read straight off disk rather than with a second git process: every
  // registered worktree leaves <common>/worktrees/<name>/gitdir holding the path to its .git file,
  // and — when new-session.mjs made it for a session — that session's claim beside it.
  const others = [];
  try {
    const base = join(commonDir.replace(/\\/g, '/'), 'worktrees');
    for (const entry of readdirSync(base)) {
      try {
        const pointer = readFileSync(join(base, entry, 'gitdir'), 'utf8').trim();
        if (!pointer) continue;
        const tree = dirname(pointer.replace(/\\/g, '/'));
        others.push({
          path: tree,
          claimedBy: claimOwner(readText(join(base, entry, CLAIM_FILE))),
          lockedBy: liveLockHolder(readText(join(tree, '.claude', 'session.lock'))),
        });
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
  let total = 0;
  let failed = 0;
  const check = (label, got, want) => {
    total += 1;
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

  // --- a worktree THIS session created: new-session.mjs claims it -------------
  // The shape that broke on 2026-09-18: a desktop-app session pinned to .claude/worktrees/<name>
  // makes _wt-<task> with new-session.mjs, then edits there with Edit and Write.
  const ME = 'session-me';
  const THEM = 'session-them';
  const MADE = 'F:/Phoenix Workforce/_wt-agents-mobile-check';
  const INSIDE_MADE = `${MADE}/.claude/worktrees/an-app-session`;
  const claimed = (extra = {}) => ({ path: MADE, claimedBy: ME, lockedBy: null, ...extra });
  // `'sessionId' in opts`, not a destructuring default: a default would turn an explicit
  // `undefined` — the payload with no session_id — back into ME and test nothing.
  const made = (trees, target, opts = {}) =>
    classify({
      target,
      sessionRoot: opts.sessionRoot ?? NESTED,
      sessionId: 'sessionId' in opts ? opts.sessionId : ME,
      primary: PRIMARY,
      others: [...ALL, ...trees],
      linked: true,
    }).decision;

  check('claimed: its creator edits a file in it', made([claimed()], `${MADE}/.claude/hooks/primary-write-guard.mjs`), 'allow');
  check('claimed: its creator edits its root file (the 2026-09-18 repro)', made([claimed()], `${MADE}/AGENTS.md`), 'allow');
  check('claimed: its creator in a sibling _wt session root too', made([claimed()], `${MADE}/x.ts`, { sessionRoot: WT }), 'allow');
  check('claimed: backslashes and a lower-case drive', made([claimed()], 'f:\\phoenix workforce\\_wt-agents-mobile-check\\src\\x.ts'), 'allow');
  check('claimed: a live lock naming its creator is no obstacle', made([claimed({ lockedBy: ME })], `${MADE}/x.ts`), 'allow');

  check('claimed: its creator still may not edit the primary', made([claimed()], `${PRIMARY}/AGENTS.md`), 'deny');
  check('claimed: its creator still may not edit another _wt', made([claimed()], `${SIBLING}/x.ts`), 'deny');
  check('claimed: its creator still may not edit a sibling nested worktree', made([claimed()], `${OTHER_NESTED}/x.ts`), 'deny');
  check('a worktree ANOTHER session claimed', made([claimed({ claimedBy: THEM })], `${MADE}/x.ts`), 'deny');
  check('an unclaimed worktree (made before claims, or from a terminal)', made([claimed({ claimedBy: null })], `${MADE}/x.ts`), 'deny');
  check('a payload with no session id matches no claim', made([claimed()], `${MADE}/x.ts`, { sessionId: undefined }), 'deny');
  check('an empty session id never matches an empty claim', made([claimed({ claimedBy: '' })], `${MADE}/x.ts`, { sessionId: '' }), 'deny');
  check('a blank session id never matches a blank claim', made([claimed({ claimedBy: ' ' })], `${MADE}/x.ts`, { sessionId: ' ' }), 'deny');
  check('another session working in it now: its live lock beats the claim', made([claimed({ lockedBy: THEM })], `${MADE}/x.ts`), 'deny');
  check('a worktree nested inside a claimed one keeps its own answer', made([claimed(), { path: INSIDE_MADE }], `${INSIDE_MADE}/x.ts`), 'deny');
  check('... whichever order git lists the two in', made([{ path: INSIDE_MADE }, claimed()], `${INSIDE_MADE}/x.ts`), 'deny');
  check('a claim does not leak to a folder whose name merely starts the same', made([claimed(), { path: `${MADE}-old` }], `${MADE}-old/x.ts`), 'deny');
  check(
    'a claim can never open the primary',
    classify({ target: `${PRIMARY}/AGENTS.md`, sessionRoot: WT, sessionId: ME, primary: PRIMARY, others: [{ path: PRIMARY, claimedBy: ME }], linked: true }).decision,
    'deny',
  );

  // --- reading a claim and a lock the way they sit on disk ---------------------
  check('claim: the shape new-session.mjs writes', claimOwner(JSON.stringify({ sessionId: ME, worktree: MADE, branch: 'codex/x' })), ME);
  check('claim: no sessionId', claimOwner(JSON.stringify({ worktree: MADE })), null);
  check('claim: a sessionId that is not a string', claimOwner('{"sessionId":42}'), null);
  check('claim: not JSON', claimOwner('garbage'), null);
  check('claim: no file', claimOwner(null), null);

  const NOW = Date.parse('2026-09-18T12:00:00.000Z');
  const lock = (fields) => JSON.stringify({ pid: 4242, host: 'Omar-Gawish', ...fields });
  check('lock: refreshed ten minutes ago is live', liveLockHolder(lock({ sessionId: THEM, refreshedAt: '2026-09-18T11:50:00.000Z' }), NOW), THEM);
  check('lock: exactly two hours old is still live', liveLockHolder(lock({ sessionId: THEM, refreshedAt: '2026-09-18T10:00:00.000Z' }), NOW), THEM);
  check('lock: refreshed three hours ago belongs to nobody', liveLockHolder(lock({ sessionId: THEM, refreshedAt: '2026-09-18T09:00:00.000Z' }), NOW), null);
  check('lock: refreshedAt outranks an old startedAt', liveLockHolder(lock({ sessionId: THEM, startedAt: '2026-09-17T00:00:00.000Z', refreshedAt: '2026-09-18T11:59:00.000Z' }), NOW), THEM);
  check('lock: an older hook wrote only startedAt', liveLockHolder(lock({ sessionId: THEM, startedAt: '2026-09-18T11:00:00.000Z' }), NOW), THEM);
  check('lock: undated belongs to nobody', liveLockHolder(lock({ sessionId: THEM }), NOW), null);
  check('lock: no session id names no holder', liveLockHolder(lock({ refreshedAt: '2026-09-18T11:59:00.000Z' }), NOW), null);
  check('lock: no file', liveLockHolder(null, NOW), null);

  // --- one rule each, not two copies that drift apart --------------------------
  const sibling = (relative) => {
    try {
      return readFileSync(new URL(relative, import.meta.url), 'utf8');
    } catch {
      return '';
    }
  };
  const staleExpr = sibling('./session-lock.mjs').match(/const STALE_MS = ([\d\s*]+);/);
  check(
    "LOCK_STALE_MS is session-lock.mjs's own STALE_MS",
    staleExpr ? staleExpr[1].split('*').reduce((ms, n) => ms * Number(n), 1) : null,
    LOCK_STALE_MS,
  );
  const writer = sibling('../../scripts/new-session.mjs');
  check('new-session.mjs writes the claim file this guard reads', writer.includes(`"${CLAIM_FILE}"`), true);
  check('new-session.mjs names the session by CLAUDE_CODE_SESSION_ID', writer.includes('CLAUDE_CODE_SESSION_ID'), true);

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
  const verdict = classify({
    target,
    sessionRoot: root || sessionRoot,
    sessionId: input.session_id,
    primary,
    others,
    linked,
  });
  if (verdict.decision !== 'deny') return;

  const own = root || sessionRoot;
  const reason =
    `This session is working in ${own}, and ${target} is in ${verdict.tree} — ` +
    `${verdict.why}. A worktree session can write there with no error at all, which is exactly why ` +
    'this is denied: the edit would succeed and land in a folder this session does not own, where ' +
    "its branch will not commit it or another session's checkout or reset will wipe it.\n\n" +
    `Write the same change under ${own} instead, or in a worktree this session makes with ` +
    '`node scripts/new-session.mjs <task>`: that script claims the new worktree for this session, ' +
    'and this guard then lets Edit and Write in. Do not route the edit through a Bash write instead ' +
    '— that is only the path this guard cannot see. If it genuinely belongs in the other tree, say ' +
    "so to the owner and let that tree's own session make it — or set PHX_PRIMARY_GUARD_OFF=1 if he " +
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
