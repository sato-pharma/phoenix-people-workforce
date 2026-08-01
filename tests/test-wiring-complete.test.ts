// verified passing at f1304d11 — this one is a REGRESSION guard, not a bug fix.
// Checked at the time of writing: all 515 test files are imported and every
// exported symbol is referenced. Nothing is orphaned today; this keeps it that
// way.
//
// Why it exists: tests/run-tests.ts has no discovery and no filter flag. A test
// file runs only if a human BOTH imports it AND calls runTest() with its export.
// Miss either and the file sits in the repo looking like coverage while never
// executing once — no error, no warning, and `pnpm test` still reports success.
//
// That failure mode is not hypothetical here. This module has already shipped a
// test that asserted a bug (`assert.equal(payload.month_key, "2026-05")` stayed
// green while production inserted 0 of 120 rows). A test that never runs is the
// same class of problem one step earlier: coverage you believe you have and
// don't. As the deductions cutover adds money-critical tests, an unwired file is
// the cheapest possible way to lose one.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

export function runTestWiringCompleteTests() {
  const runner = readFileSync("tests/run-tests.ts", "utf8");
  // Strip the import block before looking for invocations. Checking the whole
  // file would match the `import { runFooTests }` line itself, so deleting the
  // runTest() call would still "pass" — which is precisely the imported-but-
  // uninvoked case this test exists to catch. Verified: without this, removing
  // a runTest() line is not detected.
  const runnerBody = runner.replace(/^import\s[\s\S]*?;$/gm, "");
  // Top level only — tests/e2e, tests/synthetic and tests/scripts run under
  // their own configs and are deliberately not part of `pnpm test`.
  const files = readdirSync("tests").filter((name) => name.endsWith(".test.ts"));

  assert.ok(files.length > 400, `expected the full suite, found only ${files.length} test files`);

  const missingExport: string[] = [];
  const notImported: string[] = [];
  const notInvoked: string[] = [];

  for (const file of files) {
    const source = readFileSync(`tests/${file}`, "utf8");
    const exported = [...source.matchAll(/export\s+(?:async\s+)?function\s+(run\w*Tests)/g)].map((m) => m[1]);

    if (exported.length === 0) {
      missingExport.push(file);
      continue;
    }
    if (!runner.includes(`./${file}`)) {
      notImported.push(`${file} [${exported.join(", ")}]`);
      continue;
    }
    for (const symbol of exported) {
      if (!runnerBody.includes(symbol)) notInvoked.push(`${file} -> ${symbol}`);
    }
  }

  assert.deepEqual(
    missingExport,
    [],
    "every tests/*.test.ts must export a run<Name>Tests function — that is how run-tests.ts invokes it",
  );

  assert.deepEqual(
    notImported,
    [],
    "these test files are NOT imported by tests/run-tests.ts, so they never execute — `pnpm test` will still pass while their assertions are dead",
  );

  assert.deepEqual(
    notInvoked,
    [],
    "these files are imported but their exported symbol is never referenced in run-tests.ts — imported-and-uninvoked is the silent half of this failure",
  );
}
