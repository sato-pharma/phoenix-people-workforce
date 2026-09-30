// A TEST FILE NOTHING RUNS — .claude/hooks/test-registration-check.mjs, 2026-09-30.
//
// tests/run-tests.ts is the only runner in this repo: a tests/*.test.ts it does not import, or
// imports and never calls, never executes, and CI passes straight over it. The hook tells a session
// the moment it writes or edits such a file. This file pins three things:
//
//   1. The hook itself, driven as a subprocess against a scratch tests/ folder: an unregistered
//      file warns, an imported-but-never-called one warns, a registered one is silent, and files
//      that are not tests (run-tests.ts, a support file, a source file) are silent.
//   2. Its wiring: registered for Write AND Edit in .claude/settings.json, or it is a comment.
//   3. The SAME rule over the whole real tests/ folder — every *.test.ts registered today. The hook
//      only sees files a session touches; this is what catches one that slipped in any other way
//      (a cloud session, a merge, a hand edit), and it shares the hook's own definition so the two
//      can never disagree about what "registered" means.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hookPath = resolve(".claude/hooks/test-registration-check.mjs");
const settingsPath = resolve(".claude/settings.json");

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

export async function runTestRegistrationCheckTests() {
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
        'import { runAliasTests as aliased } from "./alias.test.ts";',
        "async function runTest(name: string, fn: () => void) { await fn(); }",
        'await runTest("wired", runWiredTests);',
        'await runTest("aliased", aliased);',
        "",
      ].join("\n"),
    );
    const file = (name: string, body: string) => {
      const p = join(tests, name);
      writeFileSync(p, body);
      return p;
    };
    const wired = file("wired.test.ts", "export function runWiredTests() {}\nexport function runSomeStub() {}\n");
    const half = file("half.test.ts", "export function runHalfTests() {}\n");
    const alias = file("alias.test.ts", "export async function runAliasTests() {}\n");
    const orphan = file("orphan.test.ts", "export function runOrphanTests() {}\n");
    const bare = file("bare.test.ts", "// nothing exported yet\n");
    const support = file("support/helper.ts", "export function runHelper() {}\n");

    assert.equal(runHook("Write", wired), "", "a registered test file must be silent — an exported stub the runner never imports is not a gap");
    assert.equal(runHook("Edit", alias), "", "an import renamed with `as` and called by that name is registered");

    const orphanMsg = runHook("Write", orphan);
    assert.match(orphanMsg, /TEST NOT REGISTERED/, "a test file run-tests.ts never imports must warn");
    assert.match(orphanMsg, /does not import tests\/orphan\.test\.ts/, orphanMsg);
    assert.match(orphanMsg, /import \{ runOrphanTests \} from "\.\/orphan\.test\.ts"/, "the warning must hand over the exact import line");

    const halfMsg = runHook("Edit", half);
    assert.match(halfMsg, /imports `runHalfTests` from tests\/half\.test\.ts but never calls it/, "imported-but-never-called must warn");

    assert.match(runHook("Write", bare), /exports no run function/, "a test with no run export cannot be registered and must say so");

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
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: { PostToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
  };
  const entries = (settings.hooks?.PostToolUse ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => (h.command ?? "").includes("test-registration-check.mjs")),
  );
  assert.ok(entries.length > 0, "the test-registration check must be registered as a PostToolUse hook in .claude/settings.json");
  const matchers = entries.flatMap((e) => (e.matcher ?? "").split("|"));
  for (const tool of ["Write", "Edit"]) {
    assert.ok(matchers.includes(tool), `the check must run after ${tool} (matchers: ${matchers.join("|")})`);
  }

  // 3. The same rule over the real tests/ folder.
  const hook = (await import(pathToFileURL(hookPath).href)) as {
    registrationGaps: (fileName: string, testSource: string, runnerSource: string) => string[];
  };
  const runner = readFileSync(resolve("tests/run-tests.ts"), "utf8");
  const files = readdirSync(resolve("tests")).filter((f) => f.endsWith(".test.ts"));
  assert.ok(files.length > 1000, `expected the real test folder, found ${files.length} test files`);
  const unregistered = files.flatMap((f) => hook.registrationGaps(f, readFileSync(resolve("tests", f), "utf8"), runner));
  assert.deepEqual(
    unregistered,
    [],
    "every tests/*.test.ts must be imported AND called by tests/run-tests.ts — these never run:\n" + unregistered.join("\n"),
  );
}
