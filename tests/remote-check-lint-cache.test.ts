// remote-check's persistent ESLint cache, its run ceiling, and its per-sha verdict record
// (2026-10-08 performance recovery, P0-2 and P0-3).
//
// The cache can only ever change how LONG lint takes, never its verdict: eslint's own
// `--cache-strategy content` re-hashes every file and its per-entry config hash re-lints on a config
// change; the store key hashes the lockfile, manifests, eslint config and tsconfig; a missing store
// is a cold run. What this file pins is the plumbing around that — the path rewrite in and out, the
// key moving with its inputs, lint's exit code passing through untouched, and no stray cache left in
// the tree. The real-eslint proofs (an edited file, a deleted file, a deliberate error, a config
// change, a dependency change) are run live on the box and reported in the PR.
//
// The ceiling: a hung run must END, and end as NO VERDICT (coreutils `timeout`'s 124), sized from
// the stages asked for. The verdict record: only PASS/FAIL stages are ever stored, per full sha.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CEILING_KILL_AFTER_SECONDS,
  EXIT_CEILING,
  LINT_CACHE_FUNCTION_NAME,
  LINT_RUN_PLACEHOLDER,
  RUN_BASE_CEILING_SECONDS,
  STAGE_CEILING_SECONDS,
  ceilingCommand,
  lintCacheFunction,
  mergeVerdictRecord,
  runCeilingSeconds,
  stageVerdictsFromOutput,
  typecheckExcerpt,
} from "../scripts/remote-check-plan.mjs";

const SHA = "a".repeat(40);

function bashHas(...tools: string[]): boolean {
  return spawnSync("bash", ["-c", tools.map((t) => `command -v ${t} >/dev/null`).join(" && ")], { encoding: "utf8" }).status === 0;
}

function lintCacheBehaviour(): void {
  // A scratch "remote root" and "run tree", made by bash so the paths are bash's own.
  const made = spawnSync("bash", ["-c", "d=$(mktemp -d) && mkdir -p \"$d/root\" \"$d/run.x\" \"$d/bin\" && echo \"$d\""], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const base = made.stdout.trim();
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(base)) return; // a temp path outside the validated alphabet: shape tests still ran
  const root = `${base}/root`;
  const run = `${base}/run.x`;
  const fn = lintCacheFunction({ remoteRoot: root, runDir: run }).join("\n");
  // A fake `corepack pnpm run lint`: reports what cache it was handed, writes one keyed by THIS
  // tree's absolute path (as file-entry-cache does), and exits with $FAKE_RC.
  const fake = [
    "#!/usr/bin/env bash",
    'if [ -f .eslintcache ]; then echo "SEEDED<$(cat .eslintcache)>"; else echo "NO-CACHE"; fi',
    'printf \'{"%s/src/a.ts":{"hash":"h1"}}\' "$PWD" > .eslintcache',
    'exit "${FAKE_RC:-0}"',
  ].join("\n");
  const script = (rc: number) =>
    [
      "set -u",
      `export PATH="${base}/bin:$PATH"`,
      `cd "${run}"`,
      `export FAKE_RC=${rc}`,
      fn,
      `${LINT_CACHE_FUNCTION_NAME}; echo "RC=$?"`,
      `echo "STORE<$(cat "${root}"/eslint-cache/*.json 2>/dev/null)>"`,
      `echo "FILES=$(ls "${root}/eslint-cache" | wc -l)"`,
    ].join("\n");
  const sh = (body: string) => spawnSync("bash", ["-c", body], { encoding: "utf8", timeout: 30000 });
  try {
    const setup = sh(
      [
        `cat > "${base}/bin/corepack" <<'FAKE'`,
        fake,
        "FAKE",
        `chmod +x "${base}/bin/corepack"`,
        `cd "${run}" && echo '{"lockfileVersion":"9"}' > pnpm-lock.yaml && echo '{}' > package.json && echo 'export default [];' > eslint.config.mjs && echo '{}' > tsconfig.json`,
      ].join("\n"),
    );
    assert.equal(setup.status, 0, setup.stderr);

    // 1 — cold: no store yet. Lint runs with no cache, and the saved store holds the PLACEHOLDER,
    // never this run's own path.
    const cold = sh(script(0));
    assert.match(cold.stdout, /lint cache: cold/, cold.stdout + cold.stderr);
    assert.match(cold.stdout, /NO-CACHE/);
    assert.match(cold.stdout, /RC=0/);
    assert.match(cold.stdout, new RegExp(`STORE<\\{"${LINT_RUN_PLACEHOLDER}/src/a\\.ts"`), "the store must hold the placeholder, not the run's path");
    assert.ok(!cold.stdout.includes(`STORE<{"${run}`), "the run's own path leaked into the store");

    // 2 — warm: the store is put back with THIS tree's path in place of the placeholder.
    const warm = sh(script(0));
    assert.match(warm.stdout, /lint cache: warm/);
    assert.ok(warm.stdout.includes(`SEEDED<{"${run}/src/a.ts"`), `the seeded cache must carry this run's path:\n${warm.stdout}`);

    // 3 — lint's exit code passes through untouched, warm or not (a lint FAIL stays a FAIL).
    const failed = sh(script(1));
    assert.match(failed.stdout, /RC=1/, "a failing lint must return 1 through the cache wrapper");
    const failed2 = sh(script(2));
    assert.match(failed2.stdout, /RC=2/, "an eslint crash code must pass through unchanged");

    // 4 — the key moves with its inputs: an eslint.config.mjs change starts COLD in a new store.
    const changed = sh(`cd "${run}" && echo 'export default [{rules:{}}];' > eslint.config.mjs\n${script(0)}`);
    assert.match(changed.stdout, /lint cache: cold/, "a config change must start from an empty cache");
    assert.match(changed.stdout, /FILES=2/, "a config change must use a NEW store, not overwrite the old key's");
    const dep = sh(`cd "${run}" && echo '{"lockfileVersion":"9","x":1}' > pnpm-lock.yaml\n${script(0)}`);
    assert.match(dep.stdout, /lint cache: cold/, "a lockfile change must start from an empty cache");

    // 5 — a corrupt or empty store is a cold run, never an error.
    const corrupt = sh(`for f in "${root}"/eslint-cache/*.json; do : > "$f"; done\n${script(0)}`);
    assert.match(corrupt.stdout, /lint cache: cold/);
    assert.match(corrupt.stdout, /RC=0/);
  } finally {
    sh(`rm -rf "${base}"`);
  }
}

export function runRemoteCheckLintCacheTests(): void {
  // ── The cache function's shape ──────────────────────────────────────────────────────────────────
  const lines = lintCacheFunction({ remoteRoot: "/home/phx/remote-check", runDir: "/home/phx/remote-check/runs/20261008-1.a" });
  const body = lines.join("\n");
  assert.match(body, new RegExp(`^${LINT_CACHE_FUNCTION_NAME}\\(\\) \\{`), "it must define the function remote-check.mjs's CHECKS.lint calls");
  assert.match(body, /corepack pnpm run lint\n {2}rc=\$\?/, "lint must run unchanged, and its own exit code be kept");
  assert.match(body, /return \$rc\n\}$/, "the function must return lint's own exit code");
  assert.match(body, /sha256sum pnpm-lock\.yaml pnpm-workspace\.yaml package\.json eslint\.config\.mjs tsconfig\.json/, "the key must hash the lockfile, manifests, eslint config and tsconfig");
  assert.match(body, /node --version/, "the key must include node's version");
  assert.match(body, /rm -f \.eslintcache/, "a cache already in the tree must never be trusted");
  assert.match(body, /runs\/20261008-1\\\.a\|@@PHX_RUN_TREE@@\|g/, "the save must escape the dots in the run path");
  assert.match(body, /mv -f "\$tmp" "\$store"/, "the save must be an atomic rename");
  assert.match(body, /-mtime \+14 -delete/, "old stores must be pruned");
  for (const bad of ["relative/path", "/x y", "/x;rm -rf /", "/x$(id)", "/x'q"]) {
    assert.throws(() => lintCacheFunction({ remoteRoot: bad, runDir: "/ok" }), /unsafe lint cache path/, `${bad} must be refused`);
    assert.throws(() => lintCacheFunction({ remoteRoot: "/ok", runDir: bad }), /unsafe lint cache path/, `${bad} must be refused`);
  }
  const package_ = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(package_.scripts.lint, /--cache-strategy content/, "the cache is only safe with eslint's CONTENT strategy — mtime would trust a stale entry");

  const remote = readFileSync(resolve("scripts/remote-check.mjs"), "utf8");
  assert.match(remote, /lint:\s*LINT_CACHE_FUNCTION_NAME/, "CHECKS.lint must call the cache function, not a bare `corepack pnpm run lint`");
  assert.match(remote, /names\.includes\("lint"\)\s*\?\s*\[\.\.\.PRELUDE, \.\.\.lintCacheFunction\(/, "the function must be defined in the run's prelude whenever lint is asked for");

  if (bashHas("sha256sum", "sed", "find", "mktemp", "cut")) lintCacheBehaviour();

  // ── The run ceiling ─────────────────────────────────────────────────────────────────────────────
  assert.equal(runCeilingSeconds(["typecheck"]), RUN_BASE_CEILING_SECONDS + STAGE_CEILING_SECONDS.typecheck);
  assert.equal(
    runCeilingSeconds(["lint", "typecheck", "test", "build"]),
    RUN_BASE_CEILING_SECONDS + Object.values(STAGE_CEILING_SECONDS).reduce((a, b) => a + b, 0),
  );
  assert.equal(runCeilingSeconds(["mystery"]), RUN_BASE_CEILING_SECONDS + Math.max(...Object.values(STAGE_CEILING_SECONDS)), "an unknown stage gets the LARGEST budget, never none");
  assert.equal(runCeilingSeconds(null as unknown as string[]), RUN_BASE_CEILING_SECONDS);
  assert.ok(runCeilingSeconds(["lint", "typecheck", "test", "build"]) < 45 * 60, "the ceiling must stay under the old 45-minute bottleneck");
  assert.equal(ceilingCommand(["test"]), `timeout --kill-after=${CEILING_KILL_AFTER_SECONDS} ${runCeilingSeconds(["test"])} bash -s`);
  assert.equal(EXIT_CEILING, 124, "124 is coreutils timeout's own code — anything else misreads the ceiling");

  // remote-check.mjs: the run goes through the ceiling, the local side has its own later deadline,
  // and every ending that is not a printed PASS/FAIL is NO VERDICT.
  assert.match(remote, /remoteCommand: ceilingCommand\(names\)/, "the box run must be fed to bash under the box's own timeout");
  assert.match(remote, /timeoutMs: \(ceilingSeconds \+ \d+\) \* 1000/, "the local ssh deadline must come AFTER the box's ceiling, so the box cleans up first");
  assert.match(remote, /run\.timedOut \|\| status === EXIT_CEILING \|\| status === 128 \+ 9 \|\| status === null/, "a ceiling, a SIGKILL, a local timeout and a lost status must all be caught");
  assert.match(remote, /SIGTERM[\s\S]{0,400}SIGKILL/, "a local timeout must TERM ssh, then KILL it");
  assert.match(
    remote,
    /if \(status === 0 && names\.every\(\(name\) => stageVerdicts\[name\] === "PASS"\)\)/,
    "PASS needs exit 0 AND a printed PASS line for every stage asked for",
  );
  assert.match(remote, /console\.log\("remote-check: NO VERDICT — the box run ended with exit "/, "an unrecognised ending must be NO VERDICT");
  assert.doesNotMatch(remote, /process\.exit\(status\)/, "the box's raw exit code must never be passed straight through as a verdict");

  // ── The verdict record ──────────────────────────────────────────────────────────────────────────
  const output = [
    "=== lint ===",
    "\u001b[32m--- lint PASS in 7s ---\u001b[0m",
    "=== typecheck ===",
    "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "--- typecheck FAIL in 31s ---",
    "--- test OOM-KILLED in 90s ---",
    "--- build LOCK-TIMEOUT in 1200s ---",
    "--- notastage maybe in 3s ---",
  ].join("\n");
  assert.deepEqual(stageVerdictsFromOutput(output), { lint: "PASS", typecheck: "FAIL" }, "only PASS/FAIL stages are verdicts — an OOM kill or lock timeout is not");
  assert.deepEqual(stageVerdictsFromOutput(""), {});
  assert.match(typecheckExcerpt(output), /TS2322/);
  assert.equal(typecheckExcerpt("no banners"), "");

  const first = mergeVerdictRecord(null, { sha: SHA, stages: { lint: "PASS", typecheck: "FAIL" }, source: "the box", at: "t1", excerpt: "TS2322" });
  assert.equal(first.stages.typecheck.verdict, "FAIL");
  assert.equal(first.stages.typecheck.excerpt, "TS2322", "a typecheck FAIL keeps its excerpt for the push guard");
  assert.equal(first.stages.lint.excerpt, undefined, "only a typecheck FAIL carries an excerpt");
  const second = mergeVerdictRecord(first, { sha: SHA, stages: { typecheck: "PASS", test: "OOM" as "PASS" }, source: "the box", at: "t2" });
  assert.equal(second.stages.typecheck.verdict, "PASS", "a later verdict for the same stage replaces the earlier one");
  assert.equal(second.stages.lint.verdict, "PASS", "stages the later run did not touch are kept");
  assert.equal(second.stages.test, undefined, "a non-verdict is never stored");
  const other = mergeVerdictRecord({ sha: "b".repeat(40), stages: { lint: { verdict: "FAIL" } } }, { sha: SHA, stages: {}, source: "x", at: "t" });
  assert.deepEqual(other.stages, {}, "a record about ANOTHER sha must never be merged into this one");
  assert.throws(() => mergeVerdictRecord(null, { sha: "abc123", stages: {}, source: "x", at: "t" }), /40-character sha/, "a short sha must be refused");
}
