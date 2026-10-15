#!/usr/bin/env node
// WHAT IS WAITING ON THE OWNER RIGHT NOW — answered with no model, in milliseconds.
//
//   node scripts/needs-you.mjs            the board
//   node scripts/needs-you.mjs --fresh    ignore the cache and re-read everything
//   node scripts/needs-you.mjs --json     the same facts as JSON
//   node scripts/needs-you.mjs --quiet    one line: how many things need him
//
// WHY THIS EXISTS. Merging is the one action this repository never takes on the owner's behalf
// (AGENTS.md §6: "PROTECTED ACTIONS — merging any branch or Pull Request into `main`"). So at any
// moment some number of PRs are sitting green, waiting on a click only he makes. Today the only way
// to learn that number is to open a Claude session and ask — which spends a model call, a session
// slot and a minute of his attention on a question that is pure lookup. He runs about a dozen
// sessions at once and has said plainly that the count of them is what overwhelms him
// (AGENTS.md §0). A question whose answer is already sitting in GitHub should not cost a session.
//
// THE TIER IT BELONGS TO. This is the cheapest of the three tiers: rules plus saved data, no AI,
// instant. It never asks a model anything, it never writes, and it never merges. It reads four
// facts, sorts them into "yours" and "not yours", and prints. Anything that needs judgement is by
// definition not this file's job and is left to a session.
//
// THE RULE THAT SHAPES EVERY LINE OF IT: A BOARD THAT UNDER-REPORTS IS WORSE THAN NO BOARD.
// If this prints "nothing needs you" while a PR sits green, it has actively cost him the merge —
// he stops looking, because looking is what he delegated. So every unknown is printed LOUDLY in its
// own section and is NEVER collapsed into the clean answer. That is the `?? null` discipline
// `scripts/repo-doctor.mjs` documents in four places and `scripts/branch-pr-state.mjs` states
// outright: "git and gh both answer null when the command FAILED, and collapsing that into the
// clean answer renders a check that never ran as a check that passed."
//
// WHY GITHUB'S OWN VERDICT DECIDES, AND PROTECTION ONLY EXPLAINS. `mergeStateStatus` is the gate's
// own answer to "may this merge". This file does NOT recompute that by counting passing checks
// against a list, because counting to a number is the exact failure AGENTS.md §2 records: the
// required-check list has rotted four times (4 → 5 → 6 → 4, the last on 2026-09-27 when #4527
// folded `lint`+`typecheck`+`test` into one `checks` job), and after every rename the repository
// went on stating the old list. A session that counts to a number a doc gave it waits forever for
// checks that no longer exist. So the DECISION is GitHub's, read live; the live protection contexts
// are read too, but only to EXPLAIN a blocked PR in words — never to overrule the gate, and never
// as a number to count to. When protection cannot be read the explanation degrades to "blocked" and
// the verdict is untouched, because the verdict never depended on it.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   * It does not decide worktree retirement. That question has an owner already —
//     `scripts/branch-pr-state.mjs` for the branch half and `scripts/worktree-liveness.mjs` for the
//     live-process half — and the live half needs a PowerShell PEB sweep, which is seconds, not
//     milliseconds. A second copy of a rule whose wrong answer deletes a folder is precisely what
//     branch-pr-state.mjs exists to prevent. Run `node scripts/repo-doctor.mjs` for that.
//   * It does not read Supabase. Business state (an unpublished month, a pending approval) is a
//     different tier: it needs credentials, it is slow, and getting it wrong misreports money.
//   * It does not merge, push, comment, or write anything except its own cache.
//
// THE CACHE IS WHAT MAKES IT TIER 1. Cold it is four parallel network reads, about two seconds.
// Warm it is a file read, about thirty milliseconds — so asking twice in a row costs nothing and he
// can ask as often as he likes. The cache is machine-wide rather than per-worktree ON PURPOSE:
// every fact here is global (open PRs, branch protection, what production is serving), so a dozen
// sessions asking the same question should get one answer, not twelve. A stale cache is always
// labelled with its age in Cairo time and can never be mistaken for a live read.
'use strict';

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { readProtectionContexts } from './required-check-names.mjs';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "needs-you",
  entry: import.meta.url,
  known: ["--fresh", "--json", "--quiet"],
  hints: [
    "--json prints the board as data; --quiet prints only the count; --fresh skips the cache",
  ],
});

const execFileAsync = promisify(execFile);

const REPO = 'Gawish-1997/phoenix-people-workforce';
const HEALTHZ = 'https://phoenix-hr.satopharma.com/api/healthz';

/** Where the shared answer lives. One per machine, not one per worktree — see the header. */
const CACHE_FILE = path.join(os.tmpdir(), 'phoenix-needs-you.json');

/** How long a cached answer is reused. Long enough that asking twice is free, short enough that a
 *  merge he just approved disappears from the board on his next look. */
const CACHE_TTL_MS = 60_000;

/** A PR with no push and no comment for this long is not "in flight" any more — it is a decision he
 *  has not made. It stays in his section either way; this only adds the words. */
const STALE_PR_DAYS = 3;

const NETWORK_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------------------------
// The decision core. Pure, exported, and driven directly by tests/needs-you-board.test.ts — no
// network, no clock, no filesystem. Every collector below funnels into these two functions so the
// sorting rules can be proven without a live machine, the same split as branch-pr-state.mjs.
// ---------------------------------------------------------------------------------------------

/**
 * One PR's row. `mergeStateStatus` is GitHub's own verdict and decides the bucket; the rollup and
 * the live protection contexts only supply the words.
 *
 * Buckets:
 *   'yours'   — his click is the only thing left
 *   'claude'  — work a session should finish; naming it here is what stops him acting on it
 *   'unknown' — GitHub has not answered; printed loudly rather than assumed either way
 */
export function classifyPr(pr, contexts) {
  const flags = [];
  if (pr.isDraft) return { bucket: 'claude', reason: 'draft — not offered for merge', flags };

  // A green PR that changes nothing but words is not a decision only he can make — AGENTS.md §6,
  // owner 2026-10-12: "i will not merge a small pr". It stays on the board, in Claude's lane, with
  // what to do about it; it is never dropped, because that would be the under-report this file
  // exists to prevent.
  const docsOnly = isDocsOnly(pr.files);
  const docsRow = () => ({
    bucket: 'claude',
    reason: 'green, but it changes only docs and repo rules — he will not merge a small PR (AGENTS.md §6): widen the branch with real work, or hold it for a roll-up',
    flags,
  });

  const rollup = normalizeRollup(pr.statusCheckRollup);
  const state = String(pr.mergeStateStatus || '').toUpperCase();

  if (pr.updatedAt) {
    const days = daysBetween(pr.updatedAt, pr.__now);
    if (days !== null && days >= STALE_PR_DAYS) flags.push(`no movement for ${Math.floor(days)} days`);
  }

  switch (state) {
    case 'CLEAN':
      if (docsOnly) return docsRow();
      return { bucket: 'yours', reason: 'green on every required check', flags };

    case 'UNSTABLE': {
      // The required gate passed, so GitHub WOULD take the merge — but something red is on the
      // commit. That is a session's job to look at before he is asked to approve it, so it is not
      // his row. Naming the red check is the whole point: without it this reads as an unexplained
      // demotion and somebody merges it anyway.
      const red = rollup.filter((c) => c.failed).map((c) => c.name);
      return {
        bucket: 'claude',
        reason: red.length
          ? `mergeable, but red on ${red.join(', ')} — not a required check`
          : 'mergeable, but something on the commit is red',
        flags,
      };
    }

    case 'BLOCKED':
      return { bucket: 'claude', reason: explainBlocked(rollup, contexts), flags };

    case 'DIRTY':
      return { bucket: 'claude', reason: 'merge conflicts with main', flags };

    case 'BEHIND':
      return { bucket: 'claude', reason: 'behind main and the branch must be updated first', flags };

    case 'DRAFT':
      return { bucket: 'claude', reason: 'draft — not offered for merge', flags };

    case 'HAS_HOOKS':
      if (docsOnly) return docsRow();
      return { bucket: 'yours', reason: 'green, and a repository hook will run on merge', flags };

    default:
      // UNKNOWN is GitHub's "I have not computed this yet", and it is also what an unparseable or
      // missing field lands on. It can NEVER be read as green: that is the one direction that
      // costs a merge he was never told about.
      return {
        bucket: 'unknown',
        reason: 'GitHub has not computed mergeability for this PR yet — ask again in a moment',
        flags,
      };
  }
}

/**
 * The whole board, from already-collected facts. Each fact is either `{ value }` or
 * `{ unknown: '<why>' }`; an unknown NEVER silently becomes an empty list.
 */
export function buildBoard({ prs, protection, production, now }) {
  const yours = [];
  const claude = [];
  const unknown = [];
  const knowing = [];

  if (prs.unknown) {
    unknown.push(`Open pull requests could not be read — ${prs.unknown}`);
  } else {
    const contexts = protection.unknown ? null : protection.value;
    if (protection.unknown) {
      unknown.push(`Branch protection could not be read — ${protection.unknown}. A blocked PR below is still blocked; only the explanation of WHY is missing.`);
    }
    for (const pr of prs.value) {
      const row = classifyPr({ ...pr, __now: now }, contexts);
      const entry = { number: pr.number, title: pr.title, branch: pr.headRefName, reason: row.reason, flags: row.flags };
      if (row.bucket === 'yours') yours.push(entry);
      else if (row.bucket === 'claude') claude.push(entry);
      else unknown.push(`PR #${pr.number} (${pr.title}) — ${row.reason}`);
    }
  }

  if (production.unknown) {
    unknown.push(`What production is serving could not be read — ${production.unknown}. AGENTS.md §2.3: a merge that never shipped looks exactly like one that did, so treat this as unproven, never as fine.`);
  } else {
    const p = production.value;
    if (p.behindBy === 0) {
      knowing.push(`Production is serving main's tip (${short(p.liveRevision)}).`);
    } else {
      knowing.push(
        `Production is ${p.behindBy} commit${p.behindBy === 1 ? '' : 's'} behind main — serving ${short(p.liveRevision)}, main is at ${short(p.mainTip)}. ` +
          `Railway holds a deploy until that commit's CI finishes, and a red or cancelled run makes it SKIP with nothing turning red (AGENTS.md §2.3). ` +
          `The next green merge carries a skipped one forward by itself — never redeploy or re-merge to chase it.`,
      );
    }
  }

  // Sorted so the oldest thing waiting on him is the first thing he reads.
  yours.sort((a, b) => a.number - b.number);
  claude.sort((a, b) => a.number - b.number);

  return { yours, claude, knowing, unknown };
}

// --- the small pure helpers the two functions above lean on -----------------------------------

/**
 * Is every changed path words rather than running code?
 *
 * This is what "small" means to him, and it is NOT a file count: #5802 was refused at three files
 * and again at seven, while `rollup-prs.mjs`'s `<= 4 changed files` would have called the second
 * one wide. What the two have in common is that nothing an employee can see moves — so the measure
 * is the PATHS, not how many of them there are.
 *
 * 🔴 UNKNOWN IS NEVER A DEMOTION. An empty or unreadable file list returns false, which leaves a
 * green PR in his lane. Over-reporting costs him two seconds; a merge that never reached the board
 * costs a deploy (see the header of `tests/needs-you-board.test.ts`).
 */
export function isDocsOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((entry) => {
    const p = String(entry?.path ?? entry ?? '');
    if (!p) return false;
    if (p.startsWith('docs/') || p.startsWith('.claude/')) return true;
    // A repo-root markdown file: AGENTS.md, CLAUDE.md, README.md, MEMORY.md.
    return !p.includes('/') && p.toLowerCase().endsWith('.md');
  });
}

/** gh returns CheckRun rows keyed `name`/`conclusion` and StatusContext rows keyed `context`/`state`. */
export function normalizeRollup(rollup) {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((c) => {
    const name = c?.name ?? c?.context ?? '(unnamed check)';
    const verdict = String(c?.conclusion ?? c?.state ?? '').toUpperCase();
    const status = String(c?.status ?? '').toUpperCase();
    return {
      name,
      verdict,
      passed: verdict === 'SUCCESS',
      failed: ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(verdict),
      pending: verdict === '' || verdict === 'PENDING' || status === 'IN_PROGRESS' || status === 'QUEUED',
    };
  });
}

/**
 * Why a BLOCKED PR is blocked, in words. Read against the LIVE protection contexts when they could
 * be read, and degraded to a plain "blocked" when they could not — never invented, and never a
 * count against a list from a doc.
 */
export function explainBlocked(rollup, contexts) {
  const red = rollup.filter((c) => c.failed).map((c) => c.name);
  if (red.length) return `red on ${red.join(', ')}`;

  if (!Array.isArray(contexts) || contexts.length === 0) {
    const pending = rollup.filter((c) => c.pending).map((c) => c.name);
    return pending.length ? `waiting on ${pending.join(', ')}` : 'blocked — branch protection could not be read to say which check';
  }

  const byName = new Map(rollup.map((c) => [c.name, c]));
  const waiting = [];
  for (const name of contexts) {
    const c = byName.get(name);
    if (!c) waiting.push(`${name} (no report yet)`);
    else if (!c.passed) waiting.push(c.pending ? `${name} (running)` : `${name} (${c.verdict.toLowerCase() || 'not passed'})`);
  }
  if (waiting.length) return `waiting on ${waiting.join(', ')}`;
  // Every required check passed and GitHub still says blocked: a review requirement, a merge queue,
  // or a rule this file does not model. Say exactly that rather than guessing it green.
  return 'every required check passed and GitHub still blocks the merge — open the PR to see which rule';
}

export function daysBetween(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  return (nowMs - t) / 86_400_000;
}

const short = (sha) => (typeof sha === 'string' && sha.length >= 9 ? sha.slice(0, 9) : String(sha ?? '?'));

/** Every time this repository prints goes out in Cairo local (AGENTS.md §4). */
export function cairo(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------------------------
// The collectors. Each returns `{ value }` or `{ unknown: '<why, in words>' }` and NEVER throws —
// one dead network call must degrade one line of the board, not the whole board.
// ---------------------------------------------------------------------------------------------

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    timeout: NETWORK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function why(err) {
  if (err?.code === 'ENOENT') return 'the `gh` CLI is not on PATH here';
  const stderr = String(err?.stderr ?? '');
  if (/gh auth login|authentication|not logged/i.test(stderr)) return '`gh` is not authenticated here';
  if (/403/.test(stderr)) return 'GitHub answered 403 — token scope, or the repo lost its Pro entitlement';
  if (err?.killed) return `the call did not answer within ${NETWORK_TIMEOUT_MS / 1000}s`;
  return String(err?.message ?? err).split('\n')[0];
}

async function collectPrs() {
  try {
    const raw = await gh([
      'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '60',
      // `files` is what decides docs-only, so a PR whose file list gh declines to return simply
      // stays in his lane rather than being demoted on a missing field.
      '--json', 'number,title,isDraft,mergeStateStatus,headRefName,updatedAt,statusCheckRollup,files',
    ]);
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return { unknown: 'gh returned something that is not a list of PRs' };
    return { value: parsed };
  } catch (err) {
    return { unknown: why(err) };
  }
}

async function collectProtection() {
  // Reused rather than re-implemented: scripts/required-check-names.mjs is the ONE live read of
  // branch protection in this repository, and it already returns `{ skipped: <why> }` instead of
  // throwing. A second copy of that parse is the drift this whole area exists to stop.
  const res = readProtectionContexts();
  return res.skipped ? { unknown: res.skipped } : { value: res.contexts };
}

async function collectProduction() {
  let liveRevision = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(HEALTHZ, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.json();
    liveRevision = body?.revision || null;
    if (!liveRevision) {
      return { unknown: 'healthz answered with no revision — the platform variable is missing, which is not the same as no deploy' };
    }
  } catch (err) {
    return { unknown: `healthz did not answer (${String(err?.message ?? err).split('\n')[0]})` };
  }

  let mainTip = null;
  try {
    mainTip = (await gh(['api', `repos/${REPO}/commits/main`, '--jq', '.sha'])).trim();
  } catch (err) {
    return { unknown: `main's tip could not be read (${why(err)})` };
  }
  if (!mainTip) return { unknown: "main's tip came back empty" };

  if (mainTip === liveRevision) return { value: { liveRevision, mainTip, behindBy: 0 } };

  // Compared on the SERVER rather than in this clone. Any local answer would depend on whether this
  // worktree happens to have fetched the live revision, and a dozen sessions share one object store
  // — this file must never run a fetch that another session's command is mid-way through reading.
  try {
    const raw = await gh(['api', `repos/${REPO}/compare/${liveRevision}...${mainTip}`, '--jq', '{status:.status,ahead:.ahead_by}']);
    const cmp = JSON.parse(raw || '{}');
    const behindBy = cmp.status === 'identical' ? 0 : Number(cmp.ahead ?? 0);
    return { value: { liveRevision, mainTip, behindBy: Number.isFinite(behindBy) ? behindBy : 0 } };
  } catch (err) {
    return { unknown: `the live revision could not be compared against main (${why(err)})` };
  }
}

// ---------------------------------------------------------------------------------------------
// Cache, render, run
// ---------------------------------------------------------------------------------------------

function readCache(maxAgeMs) {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (!raw || typeof raw.collectedAt !== 'number') return null;
    if (Date.now() - raw.collectedAt > maxAgeMs) return null;
    return raw;
  } catch {
    return null; // No cache, unreadable cache, cache from another version — all mean "read it fresh".
  }
}

function writeCache(payload) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    // A board that cannot cache is still a correct board. Never fail the answer over the cache.
  }
}

async function collect() {
  const [prs, protection, production] = await Promise.all([collectPrs(), collectProtection(), collectProduction()]);
  return { collectedAt: Date.now(), prs, protection, production };
}

export function render(board, { collectedAt, fromCache }) {
  const L = [];
  const age = Math.round((Date.now() - collectedAt) / 1000);
  const freshness = fromCache ? `read ${age}s ago` : 'read just now';

  L.push('');
  L.push(`NEEDS YOU — ${board.yours.length}                                   ${cairo(collectedAt)} Cairo · ${freshness}`);
  L.push('─'.repeat(92));
  if (board.yours.length === 0) {
    L.push('  Nothing is waiting on a decision only you can make.');
  } else {
    for (const r of board.yours) {
      L.push(`  merge ${r.number}`);
      L.push(`      ${r.title}`);
      L.push(`      ${r.reason}${r.flags.length ? ` · ${r.flags.join(' · ')}` : ''}`);
    }
  }

  L.push('');
  L.push(`CLAUDE'S WORK, NOT YOURS — ${board.claude.length}`);
  L.push('─'.repeat(92));
  if (board.claude.length === 0) {
    L.push('  Nothing in flight.');
  } else {
    for (const r of board.claude) {
      L.push(`  #${r.number}  ${r.title}`);
      L.push(`      ${r.reason}${r.flags.length ? ` · ${r.flags.join(' · ')}` : ''}`);
    }
  }

  if (board.knowing.length) {
    L.push('');
    L.push('WORTH KNOWING');
    L.push('─'.repeat(92));
    for (const k of board.knowing) L.push(wrap(k, 88, '  '));
  }

  if (board.unknown.length) {
    L.push('');
    L.push(`COULD NOT READ — ${board.unknown.length}   (an unknown is never the clean answer)`);
    L.push('─'.repeat(92));
    for (const u of board.unknown) L.push(wrap(u, 88, '  '));
  }

  L.push('');
  return L.join('\n');
}

/** Wrapped, never truncated — AGENTS.md §4 forbids an ellipsis, and wrapping wins over fitting. */
export function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const asJson = argv.includes('--json');
  const quiet = argv.includes('--quiet');

  const cached = fresh ? null : readCache(CACHE_TTL_MS);
  const facts = cached ?? (await collect());
  if (!cached) writeCache(facts);

  const board = buildBoard({ ...facts, now: Date.now() });

  if (asJson) {
    console.log(JSON.stringify({ collectedAt: facts.collectedAt, fromCache: Boolean(cached), ...board }, null, 2));
    return;
  }
  if (quiet) {
    const bits = [`${board.yours.length} waiting on you`];
    if (board.unknown.length) bits.push(`${board.unknown.length} could not be read`);
    console.log(bits.join(' · '));
    return;
  }
  console.log(render(board, { collectedAt: facts.collectedAt, fromCache: Boolean(cached) }));
}

// Exits 0 whatever it finds. This is a status board, never a gate — an exit code here would sooner
// or later be wired into something that blocks, and then a network blip would block it.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('needs-you.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`needs-you: ${String(err?.message ?? err)}`);
    console.error('Nothing was read, so nothing above is a clean answer.');
  });
}
