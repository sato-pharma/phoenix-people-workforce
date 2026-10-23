// THE ESLINT CACHE IS KEYED TO THE EXACT NODE RUNTIME, AND NOTHING CAN RESTORE ONE ACROSS RUNTIMES.
//
// WHY THIS EXISTS (2026-10-23). ESLint stamps every cache entry with a fingerprint of its own version,
// `process.version` and the config (eslint/lib/cli-engine/lint-result-cache.js, hashOfConfigFor), so an entry
// written under Node v24.22.0 is discarded whole under v24.21.0. ci.yml asks setup-node for a floating "24",
// and GitHub serves two runner images with different 24.x patches at once during a rollout. With a key and
// restore prefix that ignored the runtime, every one of 31 runs on 22 Oct that restored a cache written under
// the other patch re-linted all ~6,600 files (184-372 s), while all 59 same-patch, same-lockfile restores
// stayed warm (3-13 s). The fix reads `process.version` in the `static` job and puts it in BOTH the key and
// the restore prefix. This file pins:
//
//   1. The runtime step reads `process.version` (the value ESLint hashes), runs unconditionally, cannot be
//      skipped or soft-failed, and sits after Node setup and before the cache restore.
//   2. Run for real: it writes the exact runtime for a good version, and for an empty, failed, malformed,
//      partial or multi-line answer it writes a sentinel unique to the run — never an empty value.
//   3. The cache key and the restore prefix both carry that output, the hashed file set is unchanged, and
//      there is exactly one restore prefix.
//   4. Under GitHub's prefix matching, a run on one runtime can never restore a cache another runtime wrote,
//      and a run with an unverified runtime can never restore anything at all.
//   5. The lint command keeps `--cache-strategy content`.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CI = ".github/workflows/ci.yml";
const STEP_ID = "node-runtime";
const OUTPUT_REF = "${{ steps.node-runtime.outputs.version }}";
const KEY_HEAD = "eslintcache-hosted-content-";
const HASHED_FILES = "${{ hashFiles('app/**', 'src/**', 'tests/**', 'scripts/**', 'eslint.config.mjs', 'pnpm-lock.yaml') }}";
const EXACT = /^v\d+\.\d+\.\d+$/;

type Step = { name: string; lines: string[] };

/** The `static` job's steps, each as its raw lines (CRLF-safe: the laptop checks out CRLF, the runner LF). */
function staticSteps(): Step[] {
  const all = readFileSync(CI, "utf8").split(/\r?\n/);
  const start = all.findIndex((l) => /^ {2}static:\s*$/.test(l));
  assert.ok(start >= 0, `${CI} has no \`static\` job`);
  let end = all.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  if (end < 0) end = all.length;
  const steps: Step[] = [];
  for (const line of all.slice(start, end)) {
    const head = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (head) steps.push({ name: head[1], lines: [line] });
    else if (steps.length && !/^\s*#/.test(line)) steps[steps.length - 1].lines.push(line);
  }
  return steps;
}

function field(step: Step, key: string): string | null {
  for (const line of step.lines) {
    const m = new RegExp(`^ {8,10}${key}:\\s*(.*?)\\s*$`).exec(line);
    if (m) return m[1];
  }
  return null;
}

/** The literal block under `run: |`, de-indented. */
function runScript(step: Step): string {
  const i = step.lines.findIndex((l) => /^ {8}run:\s*\|\s*$/.test(l));
  assert.ok(i >= 0, `step "${step.name}" has no \`run: |\` block`);
  const body: string[] = [];
  for (const line of step.lines.slice(i + 1)) {
    if (line.trim() === "") { body.push(""); continue; }
    if (!/^ {10}/.test(line)) break;
    body.push(line.slice(10));
  }
  return body.join("\n").trim() + "\n";
}

/** Run the step's script in bash with a stand-in `node`, and read back what it wrote to $GITHUB_OUTPUT. */
function runStep(script: string, fake: { stdout?: string; exit?: number } | "real"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eslint-node-runtime-"));
  try {
    const out = path.join(dir, "github_output");
    writeFileSync(out, "");
    const scriptFile = path.join(dir, "step.sh");
    writeFileSync(scriptFile, script);
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: out, GITHUB_RUN_ID: "424242", GITHUB_RUN_ATTEMPT: "3" };
    if (fake !== "real") {
      const bin = path.join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const node = path.join(bin, "node");
      writeFileSync(node, `#!/bin/sh\nprintf '%s' "$FAKE_NODE_STDOUT"\nexit ${fake.exit ?? 0}\n`);
      chmodSync(node, 0o755);
      env.FAKE_NODE_STDOUT = fake.stdout ?? "";
      env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    }
    const r = spawnSync("bash", ["-e", scriptFile], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `the runtime step must never fail the job; it exited ${r.status}: ${r.stderr}`);
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function versionFrom(output: string): string {
  const lines = output.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `the step must write exactly one output line, wrote: ${JSON.stringify(output)}`);
  const m = /^version=(.+)$/.exec(lines[0]);
  assert.ok(m, `the step must write version=…, wrote: ${JSON.stringify(output)}`);
  return m[1];
}

/** GitHub's restore: an exact key hit, else the newest entry whose key starts with a restore prefix. */
function restores(entryKey: string, key: string, prefix: string): boolean {
  return entryKey === key || entryKey.startsWith(prefix);
}

export function runCiEslintCacheNodeRuntimeTests() {
  const steps = staticSteps();
  const at = (pred: (s: Step) => boolean, what: string) => {
    const i = steps.findIndex(pred);
    assert.ok(i >= 0, `the \`static\` job has no ${what}`);
    return i;
  };
  const setupAt = at((s) => s.lines.some((l) => /uses:\s*actions\/setup-node@/.test(l)), "actions/setup-node step");
  const runtimeAt = at((s) => field(s, "id") === STEP_ID, `step with \`id: ${STEP_ID}\``);
  const cacheAt = at((s) => s.lines.some((l) => /^\s+path:\s*\.eslintcache\s*$/.test(l)), "cache step for .eslintcache");
  const lintAt = at((s) => field(s, "run") === "pnpm run lint", "`pnpm run lint` step");

  // 1 — the runtime step: placement, unconditional, never soft-failed.
  assert.ok(setupAt < runtimeAt && runtimeAt < cacheAt && cacheAt < lintAt,
    "order must be setup-node, then the runtime step, then the ESLint cache restore, then lint");
  const runtime = steps[runtimeAt];
  assert.equal(field(runtime, "if"), null, "the runtime step must run unconditionally: a skipped step leaves its output empty");
  assert.equal(field(runtime, "continue-on-error"), null, "the runtime step must not be continue-on-error: it already never fails");
  const script = runScript(runtime);
  assert.match(script, /node -p 'process\.version'/, "the runtime must be read from process.version, the value ESLint hashes");

  // 2 — run it for real, then with every bad answer a runtime read can give.
  const real = versionFrom(runStep(script, "real"));
  if (process.version && EXACT.test(process.version)) {
    // The bash on PATH may find a different node than the one running this test; either way it must be exact.
    assert.match(real, EXACT, `the real runtime read must be an exact vX.Y.Z, got ${real}`);
  }
  assert.equal(versionFrom(runStep(script, { stdout: "v24.21.0" })), "v24.21.0");
  assert.equal(versionFrom(runStep(script, { stdout: "v24.22.1" })), "v24.22.1");
  const sentinel = "unverified-424242-3";
  for (const [label, fake] of [
    ["an empty answer", { stdout: "" }],
    ["a failed node call", { stdout: "", exit: 1 }],
    ["a major version only", { stdout: "v24" }],
    ["a version with no v", { stdout: "24.21.0" }],
    ["a pre-release tail", { stdout: "v24.21.0-rc.1" }],
    ["a second line smuggled in", { stdout: "v24.21.0\nversion=v1.0.0" }],
    ["stray whitespace", { stdout: " v24.21.0" }],
  ] as const) {
    assert.equal(versionFrom(runStep(script, fake)), sentinel,
      `${label} must key the cache to this run alone (${sentinel}), never to an empty or guessed runtime`);
  }

  // 3 — key and restore prefix both carry the runtime; the hashed set is unchanged; one prefix only.
  const cache = steps[cacheAt];
  const key = field(cache, "key");
  assert.equal(key, `${KEY_HEAD}${OUTPUT_REF}-${HASHED_FILES}`,
    "the ESLint cache key must be the content key carrying the exact runtime, with the hashed file set unchanged");
  const restoreLines = cache.lines.filter((l) => /^\s+restore-keys:/.test(l));
  assert.equal(restoreLines.length, 1, "exactly one restore-keys entry");
  assert.equal(field(cache, "restore-keys"), `${KEY_HEAD}${OUTPUT_REF}-`,
    "the restore prefix must carry the same runtime, so no other runtime's cache can match it");

  // 4 — simulate GitHub's matching with what the step can actually write.
  const keyFor = (v: string, h: string) => `${KEY_HEAD}${v}-${h}`;
  const prefixFor = (v: string) => `${KEY_HEAD}${v}-`;
  const written = [keyFor("v24.21.0", "aaa"), keyFor("v24.22.0", "bbb"), keyFor("v24.2.1", "ccc"), keyFor("unverified-1-1", "ddd")];
  assert.ok(restores(written[0], keyFor("v24.21.0", "zzz"), prefixFor("v24.21.0")), "the same runtime still restores (the point of a cache)");
  assert.ok(!restores(written[1], keyFor("v24.21.0", "zzz"), prefixFor("v24.21.0")), "v24.21.0 must not restore a v24.22.0 cache");
  assert.ok(!restores(written[0], keyFor("v24.22.0", "zzz"), prefixFor("v24.22.0")), "v24.22.0 must not restore a v24.21.0 cache");
  assert.ok(!restores(written[2], keyFor("v24.21.0", "zzz"), prefixFor("v24.21.0")) &&
    !restores(written[0], keyFor("v24.2.1", "zzz"), prefixFor("v24.2.1")),
    "the trailing dash keeps v24.2.1 and v24.21.0 apart in both directions");
  for (const entry of written) {
    assert.ok(!restores(entry, keyFor(sentinel, "zzz"), prefixFor(sentinel)), `an unverified run must restore nothing, but matched ${entry}`);
  }
  // The pre-fix key form (no runtime) must not be reachable from the new prefix either.
  assert.ok(!restores(`${KEY_HEAD}0123abcd`, keyFor("v24.21.0", "zzz"), prefixFor("v24.21.0")), "a pre-fix entry must not be restored");

  // 5 — the content strategy that makes the cache usable at all is untouched.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.lint, "eslint --cache --cache-strategy content", "the lint script must keep --cache-strategy content");
}
