// A TEST FILE NOTHING RUNS — .claude/hooks/test-registration-check.mjs, 2026-09-30.
//
// tests/run-tests.ts is the only runner in this repo. tests/test-wiring-complete.test.ts already
// turns CI red when a tests/*.test.ts is not imported and called there; this hook moves that same
// verdict to the moment a session writes or edits the file, while it can still fix it in the turn.
// This file pins three things:
//
//   1. The hook itself, driven as a subprocess against a scratch tests/ folder.
//   2. Its wiring: a PostToolUse hook for Write AND Edit in .claude/settings.json.
//   3. That it and the CI guard share ONE definition of "registered". The hook copies the guard's
//      two regexes verbatim; if either side changes alone, the hook would warn about files CI
//      accepts (or stay quiet about files CI rejects), so the copies are compared here.
//
// The fixture test sources below are built by concatenation ("export " + "function …") on purpose:
// test-wiring-complete scans every tests/*.test.ts as TEXT, and a literal fixture declaration would
// read to it as a real, unwired test in this file (it did, on this PR's first CI run).

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { settingsHookGroups } from "./support/hook-wiring.ts";

const hookPath = resolve(".claude/hooks/test-registration-check.mjs");
const EXPORT = "export " + "function ";

function runHook(tool: string, filePath: string): string {
  const raw = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath } }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
  });
  if (!raw.trim()) return "";
  return String(JSON.parse(raw).hookSpecificOutput?.additionalContext ?? "");
}

export function runTestRegistrationCheckTests() {
  // 1. The hook, against a scratch repo.
  const root = mkdtempSync(join(tmpdir(), "phx-testreg-"));
  const tests = join(root, "tests");
  mkdirSync(join(tests, "support"), { recursive: true });
  try {
    writeFileSync(
      join(tests, "run-tests.ts"),
      [
        'import { runWiredTests } from "./wired.test.ts";',
        'import { runHalfTests } from "./half.test.ts";',
        "async function runTest(name: string, fn: () => void) { await fn(); }",
        'await runTest("wired", runWiredTests);',
        "",
      ].join("\n"),
    );
    const file = (name: string, body: string) => {
      const p = join(tests, name);
      writeFileSync(p, body);
      return p;
    };
    const wired = file("wired.test.ts", `${EXPORT}runWiredTests() {}\n${EXPORT}runSomeStub() {}\n`);
    const half = file("half.test.ts", `${EXPORT}runHalfTests() {}\n`);
    const orphan = file("orphan.test.ts", `${EXPORT}runOrphanTests() {}\n`);
    const bare = file("bare.test.ts", "// nothing exported yet\n");
    const support = file("support/helper.ts", `${EXPORT}runHelperTests() {}\n`);

    assert.equal(
      runHook("Write", wired),
      "",
      "a registered test file must be silent — an exported helper not named run…Tests is not a gap",
    );

    const orphanMsg = runHook("Write", orphan);
    assert.match(orphanMsg, /TEST NOT REGISTERED/, "a test file run-tests.ts never imports must warn");
    assert.match(orphanMsg, /does not import tests\/orphan\.test\.ts/, orphanMsg);
    assert.match(
      orphanMsg,
      /import \{ runOrphanTests \} from "\.\/orphan\.test\.ts"/,
      "the warning must hand over the exact import line",
    );

    assert.match(
      runHook("Edit", half),
      /imports tests\/half\.test\.ts but never calls `runHalfTests`/,
      "imported-but-never-called must warn",
    );
    assert.match(runHook("Write", bare), /exports no `run<Name>Tests` function/, "a test with no run export must say so");

    assert.equal(runHook("Edit", join(tests, "run-tests.ts")), "", "editing the runner itself is not a test file");
    assert.equal(runHook("Write", support), "", "a support file is not a test file");
    assert.equal(runHook("Write", join(root, "src", "x.test.ts")), "", "only files directly in tests/ are checked");
    assert.equal(runHook("Read", orphan), "", "only Write/Edit/MultiEdit trigger it");
    assert.match(
      runHook("Write", orphan.replace(/\//g, "\\")),
      /TEST NOT REGISTERED/,
      "a Windows-separator path must be checked too",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 2. The wiring.
  // Read through the wiring helper: an exec-form entry's `command` is just "node" (2026-10-09).
  const entries = settingsHookGroups("PostToolUse").filter((e) =>
    (e.hooks ?? []).some((h) => (h.command ?? "").includes("test-registration-check.mjs")),
  );
  assert.ok(entries.length > 0, "the test-registration check must be registered as a PostToolUse hook in .claude/settings.json");
  const matchers = entries.flatMap((e) => (e.matcher ?? "").split("|"));
  for (const tool of ["Write", "Edit"]) {
    assert.ok(matchers.includes(tool), `the check must run after ${tool} (matchers: ${matchers.join("|")})`);
  }

  // 3. One definition of "registered", shared with the CI guard.
  const hookSource = readFileSync(hookPath, "utf8");
  const guardSource = readFileSync(resolve("tests/test-wiring-complete.test.ts"), "utf8");
  for (const [label, pattern] of [
    ["the run…Tests export pattern", String.raw`/export\s+(?:async\s+)?function\s+(run\w*Tests)/g`],
    ["the import-line strip", String.raw`/^import\s[\s\S]*?;$/gm`],
  ]) {
    assert.ok(guardSource.includes(pattern), `tests/test-wiring-complete.test.ts no longer uses ${label} ${pattern} — update the hook to match it`);
    assert.ok(hookSource.includes(pattern), `test-registration-check.mjs must use the CI guard's ${label} verbatim: ${pattern}`);
  }
}
