// MAIN-ONLY CACHE CREATION (owner, 2026-10-26): every job that runs on a pull request RESTORES caches and
// never SAVES one; only a push to main writes. setup-node's `cache: pnpm` and a combined `actions/cache@`
// both save from PR runs into a scope only that PR can read (refs/pull/N/merge) — ~350 MB per pnpm store
// that nothing else reuses, crowding main's entries out of the 10 GB repository cache.
//
// What this pins, all read from .github/workflows/ci.yml:
//   1. No setup-node `cache:` in a job that runs on a PR, and `package-manager-cache: false` on each one
//      (setup-node v6 otherwise looks for the package manager on its own — see
//      tests/scheduled-alarms-never-withhold.test.ts, rule 6).
//   2. A combined `actions/cache@` step runs only where a PR cannot reach it.
//   3. Every `actions/cache/save@` step is guarded by the exact main-push condition, saves under its own
//      restore step's primary key and path, carries one of the two non-verifying names the tree-reuse
//      shadow ignores, and saves only the pnpm store or .eslintcache.
//   4. The pnpm store: located, then restored with a key naming OS, architecture, Node major, the exact
//      pnpm version, a format version and the lockfile, and NO restore prefix; saved once, by `static`,
//      right after install. `unit` carries job-level `cache-mode: read`.
//   5. The locate step, run for real in bash with stand-in `pnpm` and `node`: a bad answer keys the cache
//      to this run alone and is never saved.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CI = ".github/workflows/ci.yml";
const CACHE_PIN = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";
const MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const PR_JOBS = ["validate", "static", "unit", "checks"];
const INSTALL_JOBS = ["validate", "static", "unit"];
const STORE_KEY = "${{ steps.pnpm-store.outputs.prefix }}-${{ hashFiles('pnpm-lock.yaml') }}";
const STORE_PATH = "${{ steps.pnpm-store.outputs.path }}";
// The tree-reuse shadow (scripts/ci-tree-reuse.mjs, NON_VERIFYING_STEPS) ignores a skipped step only under
// these exact names — a renamed save step would read as "a green job with a skipped step" on every PR.
const SAVE_NAMES = new Set(["Save the pnpm store", "Save ESLint cache"]);
const SAVE_PATHS = new Set([STORE_PATH, ".eslintcache"]);

type Step = { name: string; lines: string[] };
type Job = { name: string; head: string[]; steps: Step[] };

/** Every job, with its job-level lines and its steps as raw lines (comments dropped, CRLF-safe). */
function jobs(): Job[] {
  const all = readFileSync(CI, "utf8").split(/\r?\n/);
  const jobsAt = all.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsAt >= 0, `${CI} has no jobs: block`);
  const out: Job[] = [];
  for (const line of all.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break;
    const jobHead = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobHead) { out.push({ name: jobHead[1], head: [], steps: [] }); continue; }
    const job = out[out.length - 1];
    if (!job || /^\s*#/.test(line)) continue;
    const stepHead = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (stepHead) job.steps.push({ name: stepHead[1], lines: [line] });
    else if (job.steps.length) job.steps[job.steps.length - 1].lines.push(line);
    else job.head.push(line);
  }
  return out;
}

function field(lines: string[], key: string, indent = "8,10"): string | null {
  for (const line of lines) {
    const m = new RegExp(`^ {${indent}}${key}:\\s*(.*?)\\s*$`).exec(line);
    if (m) return m[1];
  }
  return null;
}
const stepField = (s: Step, key: string) => field(s.lines, key);
const uses = (s: Step) => stepField(s, "uses") ?? "";

function job(all: Job[], name: string): Job {
  const j = all.find((x) => x.name === name);
  assert.ok(j, `${CI} has no \`${name}\` job`);
  return j;
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

type Fake = { store?: string; storeExit?: number; pnpm?: string; pnpmExit?: number; node?: string; nodeExit?: number };

/** Run the locate step in bash with stand-in `pnpm` and `node`; return what it wrote to $GITHUB_OUTPUT. */
function runLocate(script: string, fake: Fake): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pnpm-store-locate-"));
  try {
    const out = path.join(dir, "github_output");
    writeFileSync(out, "");
    const scriptFile = path.join(dir, "step.sh");
    writeFileSync(scriptFile, script);
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "pnpm"),
      `#!/bin/sh\nif [ "$1" = "store" ]; then printf '%s' "$FAKE_STORE"; exit ${fake.storeExit ?? 0}; fi\nprintf '%s' "$FAKE_PNPM"\nexit ${fake.pnpmExit ?? 0}\n`);
    writeFileSync(path.join(bin, "node"), `#!/bin/sh\nprintf '%s' "$FAKE_NODE"\nexit ${fake.nodeExit ?? 0}\n`);
    chmodSync(path.join(bin, "pnpm"), 0o755);
    chmodSync(path.join(bin, "node"), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: out, GITHUB_RUN_ID: "424242", GITHUB_RUN_ATTEMPT: "3",
      RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_TEMP: "/home/runner/work/_temp",
      FAKE_STORE: fake.store ?? "", FAKE_PNPM: fake.pnpm ?? "", FAKE_NODE: fake.node ?? "",
    };
    const r = spawnSync("bash", ["-e", scriptFile], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `the locate step must never fail the job; it exited ${r.status}: ${r.stderr}`);
    const written: Record<string, string> = {};
    for (const line of readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean)) {
      const m = /^([a-z]+)=(.*)$/.exec(line);
      assert.ok(m, `unexpected output line ${JSON.stringify(line)}`);
      assert.ok(!(m[1] in written), `output ${m[1]} written twice`);
      written[m[1]] = m[2];
    }
    assert.deepEqual(Object.keys(written).sort(), ["path", "prefix", "verified"], "exactly path, prefix and verified");
    return written;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runCiCacheMainOnlyTests() {
  const all = jobs();

  // 1 + 2 — nothing that runs on a pull request can save.
  for (const name of PR_JOBS) {
    const j = job(all, name);
    const jobIf = field(j.head, "if", "4");
    assert.ok(!jobIf || !/pull_request/.test(jobIf), `\`${name}\` is expected to run on a pull request (job-level if: ${jobIf})`);
    for (const s of j.steps) {
      if (/^actions\/setup-node@/.test(uses(s))) {
        assert.equal(stepField(s, "cache"), null, `\`${name}\` / ${s.name}: setup-node's cache saves from PR runs — restore the store with actions/cache/restore instead`);
        assert.equal(stepField(s, "package-manager-cache"), "false", `\`${name}\` / ${s.name}: setup-node v6 caches on its own unless package-manager-cache is false`);
      }
      if (/^actions\/cache@/.test(uses(s))) {
        assert.match(stepField(s, "if") ?? "", /github\.event_name != 'pull_request'/,
          `\`${name}\` / ${s.name}: a combined actions/cache step saves at the end of a PR run — use restore, and save on main only`);
      }
    }
  }

  // 3 — every save in the file: main push only, its own restore's key and path, a known name and path.
  let saves = 0;
  for (const j of all) {
    for (const [i, s] of j.steps.entries()) {
      if (/^actions\/cache(\/restore|\/save)?@/.test(uses(s))) {
        assert.ok(uses(s).endsWith(`@${CACHE_PIN}`), `\`${j.name}\` / ${s.name}: every cache action stays on the one pinned v6.1.0 SHA`);
      }
      if (!/^actions\/cache\/save@/.test(uses(s))) continue;
      saves++;
      assert.ok(SAVE_NAMES.has(s.name), `\`${j.name}\` / "${s.name}": a save step must be named one of ${[...SAVE_NAMES].join(", ")} (the tree-reuse shadow's non-verifying names)`);
      const cond = stepField(s, "if") ?? "";
      assert.ok(cond === MAIN_PUSH || cond.startsWith(`${MAIN_PUSH} && `), `\`${j.name}\` / ${s.name}: a save must start with exactly "${MAIN_PUSH} && …", got "${cond}"`);
      assert.doesNotMatch(cond, /\|\|/, `\`${j.name}\` / ${s.name}: no || may widen the main-push guard`);
      const savePath = stepField(s, "path") ?? "";
      assert.ok(SAVE_PATHS.has(savePath), `\`${j.name}\` / ${s.name}: only the pnpm store or .eslintcache is ever saved, got "${savePath}"`);
      const keyRef = /^\$\{\{ steps\.([a-z0-9-]+)\.outputs\.cache-primary-key \}\}$/.exec(stepField(s, "key") ?? "");
      assert.ok(keyRef, `\`${j.name}\` / ${s.name}: a save uses its restore step's cache-primary-key, so the two keys cannot drift`);
      const restoreAt = j.steps.findIndex((r) => stepField(r, "id") === keyRef[1]);
      assert.ok(restoreAt >= 0 && restoreAt < i, `\`${j.name}\` / ${s.name}: the restore step ${keyRef[1]} must come first in the same job`);
      const restore = j.steps[restoreAt];
      assert.match(uses(restore), /^actions\/cache\/restore@/, `\`${j.name}\` / ${s.name}: ${keyRef[1]} must be an actions/cache/restore step`);
      assert.equal(stepField(restore, "path"), savePath, `\`${j.name}\` / ${s.name}: saves the same path its restore restored`);
      assert.match(cond, new RegExp(`steps\\.${keyRef[1]}\\.outputs\\.cache-hit != 'true'`), `\`${j.name}\` / ${s.name}: an exact hit is never re-saved`);
    }
  }
  assert.equal(saves, 2, "exactly two saves: the pnpm store and the ESLint cache, both in `static`");

  // 4 — the pnpm store in each installing job.
  for (const name of INSTALL_JOBS) {
    const j = job(all, name);
    const idx = (pred: (s: Step) => boolean, what: string) => {
      const i = j.steps.findIndex(pred);
      assert.ok(i >= 0, `\`${name}\` has no ${what}`);
      return i;
    };
    const setupAt = idx((s) => /^actions\/setup-node@/.test(uses(s)), "setup-node step");
    const locateAt = idx((s) => stepField(s, "id") === "pnpm-store", "`id: pnpm-store` locate step");
    const restoreAt = idx((s) => stepField(s, "id") === "pnpm-cache", "`id: pnpm-cache` restore step");
    const installAt = idx((s) => stepField(s, "run") === "pnpm install --frozen-lockfile", "install step");
    assert.ok(setupAt < locateAt && locateAt < restoreAt && restoreAt < installAt, `\`${name}\`: setup-node, locate, restore, then install`);
    const locate = j.steps[locateAt];
    const restore = j.steps[restoreAt];
    assert.equal(stepField(locate, "if"), null, `\`${name}\`: the locate step runs unconditionally`);
    assert.equal(stepField(restore, "if"), null, `\`${name}\`: the restore step runs on every event`);
    assert.match(uses(restore), /^actions\/cache\/restore@/, `\`${name}\`: the store is restored with actions/cache/restore`);
    assert.equal(stepField(restore, "key"), STORE_KEY, `\`${name}\`: the store key is the located prefix plus the lockfile hash`);
    assert.equal(stepField(restore, "path"), STORE_PATH, `\`${name}\`: the store path comes from the locate step`);
    assert.equal(stepField(restore, "restore-keys"), null, `\`${name}\`: no restore prefix — an exact match or nothing`);
    assert.equal(stepField(restore, "fail-on-cache-miss"), null, `\`${name}\`: a miss must never fail the job`);
    for (const s of j.steps) {
      for (const p of s.lines.map((l) => /^ {10}path:\s*(.*?)\s*$/.exec(l)?.[1]).filter(Boolean) as string[]) {
        assert.doesNotMatch(p, /node_modules|\.next|^~\/?$|\.env/, `\`${name}\` / ${s.name}: never cache ${p}`);
      }
    }
    const saveAt = j.steps.findIndex((s) => s.name === "Save the pnpm store");
    if (name === "static") {
      assert.equal(saveAt, installAt + 1, "`static` saves the store right after install");
      assert.match(stepField(j.steps[saveAt], "if") ?? "", /steps\.pnpm-store\.outputs\.verified == 'true'/, "an unverified key is never saved");
    } else {
      assert.equal(saveAt, -1, `\`${name}\` must not save the store — \`static\` is the one saver`);
      assert.ok(!j.steps.some((s) => /^actions\/cache\/save@/.test(uses(s))), `\`${name}\` saves no cache at all`);
    }
  }
  assert.equal(field(job(all, "unit").head, "cache-mode", "4"), "read", "`unit` carries job-level cache-mode: read");
  const eslintSave = job(all, "static").steps.find((s) => s.name === "Save ESLint cache");
  assert.ok(eslintSave, "`static` saves the ESLint cache on main");
  assert.match(stepField(eslintSave, "if") ?? "", /!startsWith\(steps\.node-runtime\.outputs\.version, 'unverified-'\)/, "an unverified ESLint key is never saved");
  const staticSteps = job(all, "static").steps;
  assert.equal(staticSteps.findIndex((s) => s === eslintSave), staticSteps.findIndex((s) => stepField(s, "run") === "pnpm run lint") + 1, "the ESLint cache is saved right after lint");

  // 5 — the locate step itself.
  const script = runScript(job(all, "static").steps.find((s) => stepField(s, "id") === "pnpm-store")!);
  for (const name of INSTALL_JOBS) {
    assert.equal(runScript(job(all, name).steps.find((s) => stepField(s, "id") === "pnpm-store")!), script, `\`${name}\`'s locate step is byte-identical to static's`);
  }
  const good = runLocate(script, { store: "/home/runner/setup-pnpm/node_modules/.bin/store/v10", pnpm: "11.13.1", node: "24" });
  assert.deepEqual(good, {
    path: "/home/runner/setup-pnpm/node_modules/.bin/store/v10",
    prefix: "pnpm-store-v1-Linux-X64-node24-pnpm11.13.1",
    verified: "true",
  });
  const sentinel = "pnpm-store-v1-unverified-424242-3";
  for (const [label, fake] of [
    ["a failed store call", { store: "", storeExit: 1, pnpm: "11.13.1", node: "24" }],
    ["a relative store path", { store: "store/v10", pnpm: "11.13.1", node: "24" }],
    ["a failed pnpm --version", { store: "/s", pnpm: "", pnpmExit: 1, node: "24" }],
    ["a garbage pnpm version", { store: "/s", pnpm: "11.13", node: "24" }],
    ["a pnpm version with a second line", { store: "/s", pnpm: "11.13.1\nprefix=x", node: "24" }],
    ["a failed node call", { store: "/s", pnpm: "11.13.1", node: "", nodeExit: 1 }],
    ["a garbage node major", { store: "/s", pnpm: "11.13.1", node: "v24" }],
  ] as const) {
    const r = runLocate(script, fake);
    assert.equal(r.verified, "false", `${label} must not be verified`);
    assert.equal(r.prefix, sentinel, `${label} must key the cache to this run alone, never to a guess`);
    assert.ok(!`${good.prefix}-abc`.startsWith(r.prefix) && !`${r.prefix}-abc`.startsWith(good.prefix), `${label}: the run-alone key can never meet a real one`);
  }
  // A different runtime or pnpm can never read another's store (no restore prefix, so exact keys only).
  const other = runLocate(script, { store: "/s", pnpm: "11.14.0", node: "24" });
  assert.notEqual(other.prefix, good.prefix, "a pnpm upgrade starts a new key");
  assert.notEqual(runLocate(script, { store: "/s", pnpm: "11.13.1", node: "26" }).prefix, good.prefix, "a Node major upgrade starts a new key");
}
