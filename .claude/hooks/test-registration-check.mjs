#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit) check — A TEST FILE NOTHING RUNS.
//
// tests/run-tests.ts is the ONLY way a test runs in this repo: no auto-discovery, no glob, no
// per-file runner. A tests/*.test.ts that it does not import, or imports and never calls, is dead
// code that reads exactly like coverage — the add-test skill exists because that happened. This
// hook looks at the test file a session just wrote or edited and, if run-tests.ts would not run it,
// tells the session so while it is still in the turn that can fix it.
//
// WHAT "REGISTERED" MEANS HERE — measured 2026-09-30 over all 1,967 test files, every one of which
// passes it: run-tests.ts has `import { … } from "./<file>.test.ts"`, and every name in that import
// is used again below it (the `await runTest(…, runX)` call). Exported helpers the runner does not
// import are NOT required to be called — 13 files export such helpers (runMarketingSlaDaily and the
// like, stubs for the code under test), and demanding them would be a false alarm on every edit.
//
// It WARNS, it never blocks: the tool already ran, and a session normally writes the test first and
// registers it one edit later — the first warning of that pair is the nudge, not a fault. Fails open.
// Owner instruction: "build the unregistered-test warning hook", 2026-09-30.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const TEST_FILE = /(?:^|[\\/])tests[\\/]([^\\/]+\.test\.ts)$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The run* functions a test file exports — what run-tests.ts could call. */
export function exportedRunFunctions(testSource) {
  const names = new Set();
  for (const m of String(testSource).matchAll(/export\s+(?:async\s+)?function\s+(run\w*)/g)) names.add(m[1]);
  for (const m of String(testSource).matchAll(/export\s+const\s+(run\w*)\s*=/g)) names.add(m[1]);
  return [...names];
}

/**
 * What stops run-tests.ts running this file, as plain sentences — an empty list means it runs.
 * `fileName` is the bare file name, e.g. `foo.test.ts`.
 */
export function registrationGaps(fileName, testSource, runnerSource) {
  const runner = String(runnerSource);
  const exported = exportedRunFunctions(testSource);
  const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']\\./${escapeRe(fileName)}["'];?`, 'g');
  const imports = [...runner.matchAll(importRe)];

  if (imports.length === 0) {
    if (exported.length === 0) {
      return [
        `tests/${fileName} exports no run function and tests/run-tests.ts does not import it, so it never runs. ` +
          'Export a `runXxxTests` function from it, then register that in run-tests.ts.',
      ];
    }
    return [`tests/run-tests.ts does not import tests/${fileName}, so it never runs.`];
  }

  const withoutImports = imports.reduce((text, m) => text.split(m[0]).join(''), runner);
  const gaps = [];
  for (const m of imports) {
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const local = spec.split(/\s+as\s+/).pop().trim();
      if (!new RegExp(`\\b${escapeRe(local)}\\b`).test(withoutImports)) {
        gaps.push(`tests/run-tests.ts imports \`${local}\` from tests/${fileName} but never calls it, so it never runs.`);
      }
    }
  }
  return gaps;
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

  const raw = input.tool_input?.file_path || '';
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
