#!/usr/bin/env node
// DOES `tests/run-tests.ts` STILL PARSE? — 0.3 seconds, no `tsc`, and it is the one local check that can
// see a syntax error in the file every new-test PR edits.
//
// WHY IT EXISTS. On 2026-09-30 a registration description in `tests/run-tests.ts` was given a
// double-quoted phrase inside a double-quoted string. `TS1005`. It reached a pull request and was caught
// by `scripts/remote-check.mjs typecheck` on the CI box, 118 seconds, AFTER the local run had reported
// green.
//
// The local run reported green because it never parsed that file. Iterating on one suite means
// `import('./tests/x.test.ts')` then calling its exported `runXTests()`, which is the right way to work
// and never loads the registry at all. `pnpm run test` WOULD have crashed on it — `--experimental-strip-types`
// erases types but still has to parse, and `run-tests.ts` is the suite's own entry point — so the blind
// spot is the ISOLATED run, not the suite. That is why the remedy is not a remote typecheck: it is a
// parse, of the one file an isolated run never reads.
//
// WHAT IT IS NOT. This is NOT a typecheck and must never be described as one. It answers exactly one
// question — does this file parse — and a file that parses can still be full of type errors that only
// the PR's `checks` job will find (AGENTS.md §7; a local typecheck is denied by `bash-guard.mjs` C8, and
// this script gives that clause nothing to refuse because `tsc` is never invoked).
//
//   node scripts/check-tests-parse.mjs              # the registry, plus every registered suite file
//   node scripts/check-tests-parse.mjs --registry   # the registry alone — the 0.3s case
//   node scripts/check-tests-parse.mjs <file> …     # named files, for a test to drive
//
// Exit 0 everything parsed · 1 something did not · 2 a file could not be read at all.
'use strict';

import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-tests-parse",
  entry: import.meta.url,
  known: ["--registry"],
});

/** The file an isolated suite run never loads, and the reason this script exists. */
export const REGISTRY = 'tests/run-tests.ts';

/**
 * Whether one file parses as TypeScript, using Node's own stripper.
 *
 * `stripTypeScriptTypes` erases types without executing anything, so a file with side effects — and
 * `tests/run-tests.ts` runs the entire suite on import — is safe to check this way. Importing it to
 * find out would run 2,000 tests to answer a question about punctuation.
 *
 * A file that cannot be READ is a different answer from a file that does not parse, and the caller is
 * told which: a path typo must never read as a clean parse.
 *
 * @param {string} file
 * @returns {{ file: string, ok: boolean, unreadable?: true, why?: string }}
 */
export function parses(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    return { file, ok: false, unreadable: true, why: String(err?.message ?? err).split('\n')[0] };
  }
  try {
    stripTypeScriptTypes(source, { mode: 'strip' });
    return { file, ok: true };
  } catch (err) {
    return { file, ok: false, why: String(err?.message ?? err).split('\n')[0] };
  }
}

/** Every `*.test.ts` beside the registry. A suite file breaks the run that imports it, so it is cheap cover. */
function suiteFiles() {
  try {
    return readdirSync('tests')
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => path.posix.join('tests', name))
      .sort();
  } catch {
    return [];
  }
}

// Not `import.meta.main` — that is Node 24 only, and this has to keep working on the CI box's node.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-tests-parse.mjs');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const named = args.filter((a) => !a.startsWith('--'));
  const files = named.length > 0
    ? named
    : args.includes('--registry') ? [REGISTRY] : [REGISTRY, ...suiteFiles()];

  const started = Date.now();
  const results = files.map(parses);
  const broken = results.filter((r) => !r.ok);
  const unreadable = broken.filter((r) => r.unreadable);

  for (const r of broken) {
    console.error(r.unreadable
      ? `[tests-parse] COULD NOT READ ${r.file} — ${r.why}`
      : `[tests-parse] DOES NOT PARSE ${r.file} — ${r.why}`);
  }
  if (broken.some((r) => !r.unreadable && r.file === REGISTRY)) {
    console.error(`[tests-parse] ${REGISTRY} is the suite's entry point, so `
      + '`pnpm run test` cannot start at all — and an isolated `runXTests()` run would not have noticed. '
      + 'A description holding a double-quoted phrase inside a double-quoted string is the usual cause.');
  }
  console.log(`[tests-parse] ${results.length - broken.length}/${results.length} parsed in ${Date.now() - started}ms `
    + '— this is a PARSE, not a typecheck: the PR\'s `checks` job is still the only thing that reads types.');
  process.exit(unreadable.length > 0 ? 2 : broken.length > 0 ? 1 : 0);
}
