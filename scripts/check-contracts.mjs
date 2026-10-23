#!/usr/bin/env node
// `pnpm run check:contracts` — the offline repo-wide contract gates, in seconds, before the push.
//
// WHAT IT IS FOR. The gates that redden `validate/Test` are mostly whole-repo contracts, not the
// PR's own feature test, and until now the only way to meet one was to push and wait ~210s for CI
// (or ~125s for the box). This runs all of them locally and REPORTS THEM ALL — the suite rethrows
// at the first red, so one failure has always hidden the next one. The gate list, the measured
// failure counts and the one gate left out are in scripts/check-contracts-gates.mjs.
//
// 🔴 IT IS NOT A GATE AND NEVER BECOMES ONE. It starts nothing, refuses nothing and blocks no push
// — the owner ruled "keep the pre-push test as a rule, no guard" on 2026-10-04. The PR's own
// `validate` + `checks` remain the verdict. Run it when you want the answer early; skip it freely.
//
// 🔴 IT IS NOT IN THE `ci` SCRIPT, DELIBERATELY. tests/ci-gate-parity.test.ts requires every
// `check:*` named in `ci` to appear literally in a .github/workflows/*.yml file, and a CI step
// would be pure waste anyway — `validate` already runs every one of these, which is the point: each
// gate here is the step's own code, so this answers the same question earlier and never instead.
//
// This file only launches: the gates need `--experimental-strip-types` and the alias loader, which
// a plain `node scripts/check-contracts.mjs` does not have, so it spawns a child that does.
'use strict';

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_GATES,
  GATE_RUNNER,
  MAX_LINT_FILES,
  MIGRATION_CHECK_SCRIPT,
  SHARD_RESULT_RE,
  TOOL_GATES,
  TOOL_GATE_BYTES,
  TS_NODE_FLAGS,
  TYPECHECK_NOTE,
  changedFileCommands,
  contractShardCount,
  coverageProblems,
  eslintArgs,
  lintCacheLocation,
  lintableChangedFiles,
  migrationDetail,
} from './check-contracts-gates.mjs';
import { clearContractsRecord, headState, writeContractsPass } from './lib/check-contracts-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 🔴 AN UNKNOWN FLAG IS REFUSED, BECAUSE A SILENTLY IGNORED ONE IS INDISTINGUISHABLE FROM AN OLD
// SCRIPT (scripts/rollup-prs.mjs, same rule).
const KNOWN_FLAGS = new Set(['--list', '--help', '-h']);

const argv = process.argv.slice(2);
const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknown.length > 0) {
  console.error(
    '[check-contracts] unknown flag: ' +
      unknown.join(', ') +
      '\nKnown: ' +
      [...KNOWN_FLAGS].join(', '),
  );
  process.exit(2);
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'node scripts/check-contracts.mjs            run every offline contract gate (exit 1 on any failure)\n' +
      'node scripts/check-contracts.mjs --list    print the gate list and exit\n' +
      '\nIt is optional and never a gate. The PR\'s own validate + checks are the verdict.',
  );
  process.exit(0);
}

if (argv.includes('--list')) {
  console.log(`[check-contracts] ${CONTRACT_GATES.length} offline repo-wide gates:`);
  for (const gate of CONTRACT_GATES) {
    const red = gate.redJobs === null ? '' : `  (${gate.redJobs} red CI jobs, 9-13 Oct 2026)`;
    console.log(`  ${gate.slug.padEnd(32)} ${gate.file}${red}`);
  }
  console.log(`\n[check-contracts] ${TOOL_GATES.length} tool gate(s):`);
  for (const gate of TOOL_GATES) {
    const red = gate.redJobs === null ? '' : `  (${gate.redJobs} red CI jobs, 9-13 Oct 2026)`;
    console.log(`  ${gate.slug.padEnd(32)} ${gate.what}${red}`);
  }
  console.log('\n' + TYPECHECK_NOTE);
  process.exit(0);
}

/**
 * One shard.
 *
 * 🔴 CWD IS PINNED TO THE REPO ROOT. access-registry-coverage resolves app/api from
 * `process.cwd()`, agents-long-hooks-cite-docs reads AGENTS.md and .claude/rules/*.md by relative
 * path, and neutral-wording sweeps src/ and app/ the same way — so a run from a subdirectory would
 * not fail, it would measure a smaller tree and PASS. The alias-loader path is relative too.
 *
 * Output is captured rather than inherited, so the parent can read each shard's coverage line and
 * keep one shard's gates together instead of interleaving two shards into one unreadable log
 * (`a-sharded-test-jobs-log-tail-is-the-other-shard`).
 */
function runShard(index, total) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...TS_NODE_FLAGS, GATE_RUNNER], {
      cwd: ROOT,
      env: { ...process.env, PHX_CONTRACT_SHARD: `${index}/${total}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', (error) => resolve({ index, out, spawnError: error }));
    child.on('close', (code, signal) => resolve({ index, out, code, signal }));
  });
}

/** Any command, captured. Nothing here is interactive, and nothing is given a shell. */
function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * A tool gate's result. Every runner below returns one of these rather than throwing, and SKIP is a
 * first-class answer — there are honest reasons one cannot run (no `origin/main` to diff against, a
 * branch far too wide for a seconds-long check, a child the memory watchdog reaped), and reporting
 * one of those as a PASS would be the whole failure mode this script exists to avoid.
 *
 * @param {string} slug
 * @param {number} startedAt
 */
function reporter(slug, startedAt) {
  return (status, detail, output = '') => ({ slug, status, ms: Date.now() - startedAt, detail, output });
}

/** ESLint ERRORS on the files this branch changed. */
async function runChangedFilesLint() {
  const since = reporter('changed-files-lint', Date.now());

  const base = await capture('git', ['merge-base', 'origin/main', 'HEAD']);
  if (base.code !== 0 || !base.stdout.trim()) {
    return since('SKIP', 'no merge base with origin/main — fetch, or let the PR lint it');
  }

  const reads = await Promise.all(
    changedFileCommands(base.stdout.trim()).map((args) => capture('git', args)),
  );
  const failedRead = reads.find((read) => read.code !== 0);
  if (failedRead) {
    return since('SKIP', `git could not list the changed files: ${failedRead.stderr.trim().slice(0, 160)}`);
  }

  const files = lintableChangedFiles(reads.map((read) => read.stdout));
  if (files.length === 0) {
    return since('PASS', 'no lintable file changed on this branch');
  }
  if (files.length > MAX_LINT_FILES) {
    return since('SKIP', `${files.length} changed files is past the ${MAX_LINT_FILES} this check will lint`);
  }

  const cache = lintCacheLocation(ROOT);
  mkdirSync(path.dirname(cache), { recursive: true });
  const lint = await capture(process.execPath, eslintArgs(files, cache));

  const where = `${files.length} changed file${files.length === 1 ? '' : 's'}`;
  if (lint.signal) return since('SKIP', `eslint was killed by ${lint.signal} — no verdict`);
  if (lint.code === 0) return since('PASS', where);
  if (lint.code === 1) return since('FAIL', where, (lint.stdout + lint.stderr).trim());
  return since('SKIP', `eslint exited ${lint.code}, which is its own failure, not yours`, (lint.stdout + lint.stderr).trim());
}

/**
 * `validate`'s "Check migrations" step, run as the step runs it.
 *
 * 🔴 IT SPAWNS CI'S OWN SCRIPT, SO THERE IS NOTHING HERE TO DRIFT. The only judgement in this
 * function is the exit-code reading: `check-migrations.mjs` exits 0 on a clean run AND on a
 * warnings-only run (a `DROP TABLE` with no `-- SAFE:` note warns and passes, in CI too), 1 on any
 * error, and anything else — or a signal — is a child that did not finish, which is NO VERDICT.
 */
async function runMigrationCheck() {
  const since = reporter('migration-check', Date.now());
  const run = await capture(process.execPath, [MIGRATION_CHECK_SCRIPT]);
  const output = (run.stdout + run.stderr).trim();
  const detail = migrationDetail(run.stdout + run.stderr) ?? 'the migration folder';

  if (run.signal) return since('SKIP', `check-migrations was killed by ${run.signal} — no verdict`);
  if (run.code === 0) return since('PASS', detail);
  if (run.code === 1) return since('FAIL', detail, output);
  return since('SKIP', `check-migrations exited ${run.code}, which is its own failure, not yours`, output);
}

/** Each tool gate's runner, by slug. */
const TOOL_GATE_RUNNERS = {
  'changed-files-lint': runChangedFilesLint,
  'migration-check': runMigrationCheck,
};

// 🔴 A GATE IN THE TABLE WITH NO RUNNER IS **NO VERDICT**, NEVER A QUIET SKIP. The table is the
// published list — `--list` prints it and docs/testing.md counts it — so a gate listed and not run
// is the one shape where this script's summary would claim coverage it does not have.
const unwired = TOOL_GATES.filter((gate) => typeof TOOL_GATE_RUNNERS[gate.slug] !== 'function');
if (unwired.length > 0) {
  console.error(
    '[check-contracts] NO VERDICT — tool gate(s) listed with no runner in this file: ' +
      unwired.map((gate) => gate.slug).join(', '),
  );
  process.exit(2);
}

// 🔴 THE TOOL CHILDREN'S MEMORY IS RESERVED BEFORE THE SHARDS ARE COUNTED. They run alongside the
// shards — which is why the whole check still lands in seconds rather than adding the lint's 3-6s
// and the migration check's half-second to the end — but on a box with 1.6 GB free, five unbudgeted
// node processes is how `mem-watchdog.ps1` reaps one of them and the run reports nothing at all.
const total = contractShardCount(process.env.PHX_CONTRACT_SHARDS, { reserveBytes: TOOL_GATE_BYTES });
const startedAt = Date.now();
const [results, toolResults] = await Promise.all([
  Promise.all(Array.from({ length: total }, (_unused, i) => runShard(i + 1, total))),
  Promise.all(TOOL_GATES.map((gate) => TOOL_GATE_RUNNERS[gate.slug]())),
]);

const problems = [];
let failedGates = 0;
for (const result of results) {
  // The ExperimentalWarning about --experimental-loader is node's, on every run, and says nothing
  // about this repo — it is the one line worth dropping so a real message is not lost beside it.
  const lines = result.out
    .split('\n')
    .filter((line) => !SHARD_RESULT_RE.test(line))
    .filter((line) => !/ExperimentalWarning|--trace-warnings|^--import 'data:text\/javascript/.test(line))
    .join('\n')
    .trim();
  if (lines) console.log(lines);

  failedGates += (result.out.match(/^FAIL /gm) ?? []).length;
  if (result.spawnError) {
    problems.push(`shard ${result.index}/${total} could not start: ${result.spawnError.message}`);
  } else if (result.signal) {
    // A signal is NO VERDICT, never a pass — a run the memory watchdog reaped prints nothing, and
    // reading that as green is `piping-a-test-run-to-tail-destroys-the-verdict` all over again.
    problems.push(`shard ${result.index}/${total} was killed by ${result.signal} — no verdict`);
  } else if (result.code !== 0 && !/^FAIL /m.test(result.out)) {
    problems.push(`shard ${result.index}/${total} exited ${result.code} without naming a failing gate`);
  }
}
problems.push(...coverageProblems(results, total));

// Each tool gate reports on its own line, after the contract gates and before the summary, so a
// lint or migration failure is never mistaken for one of the suite's contracts.
for (const tool of toolResults) {
  console.log(`${tool.status} ${tool.slug} (${tool.ms}ms)  ${tool.detail}`);
  if (tool.output) console.error(tool.output);
}

const failedTools = toolResults.filter((tool) => tool.status === 'FAIL');
const skippedTools = toolResults.filter((tool) => tool.status === 'SKIP');

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const shardNote = total === 1 ? '1 shard' : `${total} shards`;
const note = '\n  ' + TYPECHECK_NOTE;

/**
 * A run that did not end in a clean full pass must leave no record behind for this commit: the record
 * is read before a push, and a stale pass is worse than none. Fails soft — bookkeeping, never a gate.
 */
function forgetAnyRecordedPass() {
  const head = headState(ROOT);
  if (head) clearContractsRecord(ROOT, head.sha);
}

if (problems.length > 0) {
  console.error(
    `\n[check-contracts] NO VERDICT after ${seconds}s (${shardNote}) — the run cannot be trusted:\n  ` +
      problems.join('\n  ') +
      '\n  Re-run it, or read the PR\'s own validate.',
  );
  forgetAnyRecordedPass();
  process.exit(2);
}
if (failedGates > 0 || failedTools.length > 0) {
  const parts = [];
  if (failedGates > 0) parts.push(`${failedGates} of ${CONTRACT_GATES.length} contract gates`);
  for (const tool of failedTools) parts.push(tool.slug);
  console.error(
    `\n[check-contracts] ${parts.join(' and ')} FAILED in ${seconds}s (${shardNote}).` +
      '\n  A contract gate is a whole-repo rule, not your feature — fix it here rather than in a red PR.' +
      note,
  );
  forgetAnyRecordedPass();
  process.exit(1);
}
// 🔴 A SKIP IS NAMED IN THE SUMMARY, NEVER ROLLED INTO "clean". A gate that could not run is the
// one thing a reader must not take for a pass, and the summary is the line a session actually reads.
const toolNote = skippedTools.length === 0
  ? `and all ${toolResults.length} tool gates are clean`
  : `${toolResults.length - skippedTools.length} of ${toolResults.length} tool gates clean, and `
    + skippedTools.map((tool) => `${tool.slug} was SKIPPED — ${tool.detail}`).join('; ');
console.log(
  `\n[check-contracts] ${CONTRACT_GATES.length} contract gates passed in ${seconds}s (${shardNote}), ` +
    `${toolNote}.` +
    note,
);
// 🔴 A SKIPPED GATE IS NOT A PASS, SO IT IS NOT RECORDED EITHER — the record exists to quiet the
// pre-push reminder, and quieting it on a run that could not read every gate is the one thing it
// must not do. A clean full run records; anything else clears whatever this commit held.
if (skippedTools.length === 0) {
  const recorded = writeContractsPass(ROOT, { gates: CONTRACT_GATES.length, seconds: Number(seconds) });
  console.log(
    recorded
      ? `  recorded for ${recorded.sha.slice(0, 9)} — the next \`git push\` of that commit says nothing about contracts.`
      : '  not recorded: the working tree has uncommitted changes, so this pass describes no commit. ' +
        'Commit, re-run it, and the push goes quiet.',
  );
} else {
  forgetAnyRecordedPass();
}
process.exit(0);
