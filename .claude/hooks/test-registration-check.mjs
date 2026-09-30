#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit) check — A TEST FILE NOTHING RUNS.
//
// tests/run-tests.ts is the ONLY way a test runs in this repo: no auto-discovery, no glob, no
// per-file runner. A tests/*.test.ts that it does not import, or imports and never calls, is dead
// code that reads exactly like coverage — the add-test skill exists because that happened. This
// hook looks at the test file a session just wrote or edited and, if run-tests.ts would not run it,
// tells the session so while it is still in the turn that can fix it.
//
// WHAT "REGISTERED" MEANS HERE is EXACTLY what tests/test-wiring-complete.test.ts enforces in CI —
// that guard already turns the required check red; this hook only moves the same verdict to the
// moment the file is written, while the session can still fix it. The file must export a
// `run<Name>Tests` function, run-tests.ts must mention `./<file>.test.ts`, and each such export must
// appear in run-tests.ts OUTSIDE its import lines. Exported helpers not named `run…Tests` (13 files
// have stubs like runMarketingSlaDaily) are ignored, as the guard ignores them. The two regexes
// below are copied from that guard verbatim, and tests/test-registration-check.test.ts fails if
// they ever drift apart — never "improve" one side alone.
//
// It WARNS, it never blocks: the tool already ran, and a session normally writes the test first and
// registers it one edit later — the first warning of that pair is the nudge, not a fault. Fails open.
// Owner instruction: "build the unregistered-test warning hook", 2026-09-30.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const TEST_FILE = /(?:^|[\\/])tests[\\/]([^\\/]+\.test\.ts)$/;

// Verbatim from tests/test-wiring-complete.test.ts — see the header. Pinned equal by the test.
const EXPORTED_RUN_TESTS = /export\s+(?:async\s+)?function\s+(run\w*Tests)/g;
const IMPORT_LINES = /^import\s[\s\S]*?;$/gm;

/** The `run…Tests` functions a test file exports — what run-tests.ts must call. */
export function exportedRunFunctions(testSource) {
  return [...String(testSource).matchAll(EXPORTED_RUN_TESTS)].map((m) => m[1]);
}

/**
 * What stops run-tests.ts running this file, as plain sentences — an empty list means it runs.
 * `fileName` is the bare file name, e.g. `foo.test.ts`. Same three verdicts as the CI guard.
 */
export function registrationGaps(fileName, testSource, runnerSource) {
  const runner = String(runnerSource);
  const exported = exportedRunFunctions(testSource);
  if (exported.length === 0) {
    return [
      `tests/${fileName} exports no \`run<Name>Tests\` function, so tests/run-tests.ts has nothing to call.`,
    ];
  }
  if (!runner.includes(`./${fileName}`)) {
    return [`tests/run-tests.ts does not import tests/${fileName}, so it never runs.`];
  }
  const runnerBody = runner.replace(IMPORT_LINES, '');
  return exported
    .filter((symbol) => !runnerBody.includes(symbol))
    .map((symbol) => `tests/run-tests.ts imports tests/${fileName} but never calls \`${symbol}\`, so it never runs.`);
}

function main() {
  const payload = (() => {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!payload.trim()) return;
  const input = JSON.parse(payload);
  const tool = input.tool_name || '';
  if (tool !== 'Write' && tool !== 'Edit' && tool !== 'MultiEdit') return;

  // Backslashes to forward slashes before any path work: node accepts `/` on Windows, while on
  // Linux a `\` is an ordinary filename character, so dirname() would not split on it.
  const raw = String(input.tool_input?.file_path || '').replace(/\\/g, '/');
  if (!raw) return;
  const target = isAbsolute(raw) ? raw : resolve(input.cwd || process.cwd(), raw);
  const match = TEST_FILE.exec(target);
  if (!match) return;

  const fileName = match[1];
  const runnerPath = join(dirname(target), 'run-tests.ts');
  if (basename(target) === 'run-tests.ts' || !existsSync(runnerPath) || !existsSync(target)) return;

  const gaps = registrationGaps(fileName, readFileSync(target, 'utf8'), readFileSync(runnerPath, 'utf8'));
  if (gaps.length === 0) return;

  const names = exportedRunFunctions(readFileSync(target, 'utf8'));
  const example = names[0] ?? 'runXxxTests';
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `TEST NOT REGISTERED: ${gaps.join(' ')} There is no auto-discovery here — tests/run-tests.ts is ` +
          'the only runner, and CI passes straight over an unregistered file. Before you finish this task, ' +
          `add \`import { ${names.join(', ') || example} } from "./${fileName}";\` beside the other imports ` +
          `and \`await runTest("<what it proves>", ${example});\` among the runTest calls (the add-test skill ` +
          'does both). If you are about to register it in your next edit, carry on.',
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  process.exit(0); // fail open, always
}
