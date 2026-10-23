// `pnpm run check:contracts` runs the suite's OWN gates, and cannot quietly stop running them.
//
// scripts/check-contracts.mjs exists because the gates that redden `validate/Test` are mostly
// whole-repo contracts rather than the PR's own feature test, and a session could not see one
// before pushing (94 of the 106 failed PR runs since 9 Oct 2026 failed in that step). It reaches
// each gate through the SAME exported run function tests/run-tests.ts imports — never a second copy
// of an assertion, because a re-implemented gate would drift from the one that actually gates the
// merge and the script's PASS would then be a lie.
//
// 🔴 WHAT THIS FILE PROTECTS IS THAT COUPLING. A gate renamed, retired or moved in run-tests.ts
// would leave `check-contracts` importing something nothing gates any more — or importing nothing
// at all — and a check that runs nothing prints PASS. So every entry is held against run-tests.ts
// by name AND by export, the shard split is held to covering each gate exactly once, and the
// offline rule is held with a tripwire. The script is never a gate itself: the owner ruled "no
// guard" on 2026-10-04 and the PR's `validate` + `checks` stay the verdict.
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  CONTRACT_GATES,
  CONTRACT_SHARD_BYTES,
  ESLINT_BIN,
  GATE_RUNNER,
  MAX_CONTRACT_SHARDS,
  MAX_LINT_FILES,
  MIGRATION_CHECK_SCRIPT,
  NOT_OFFLINE,
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
  shardGates,
} from "../scripts/check-contracts-gates.mjs";

import { stripComments } from "./support/comment-strip.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A `runTest("name", runXTests)` pairing, which is the only thing that makes a gate run at all. */
const REGISTRATION = /runTest\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\w+)\s*,?\s*\)/g;

/**
 * Every `import … from "…"` specifier in a module's source, type-only imports excluded.
 *
 * `import type` is erased by `--experimental-strip-types`, so a type-only import of a
 * Supabase-shaped module puts nothing in the process and must not be read as a breach.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(source).matchAll(/(?:^|\n)import\s([\s\S]*?)\sfrom\s+"([^"]+)";/g)) {
    if (/^type\s/.test(match[1].trim())) continue;
    found.push(match[2]);
  }
  return found;
}

/**
 * Where a specifier actually lands on disk — the same resolution `tests/alias-loader.mjs` performs,
 * because the walk below has to follow exactly what the child process will load.
 *
 * `@/x` is tried against the repo root and then `src/` (tsconfig's `"@/*": ["./*", "./src/*"]`, the
 * shadowing that `at-slash-lib-shadows-src-lib-via-tsconfig-paths` records), a relative specifier
 * against the importing file, and an extensionless one takes `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
 * `.cjs` or `index.*`. A BARE package specifier returns null: `node:fs` and anything in
 * `node_modules` is not ours to walk, and `NOT_OFFLINE` has already read the specifier itself.
 */
const ALIAS_ROOTS = ["", "src"];
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function resolveModule(specifier: string, fromFile: string): string | null {
  const bases: string[] = [];
  if (specifier.startsWith("@/")) {
    for (const root of ALIAS_ROOTS) bases.push(path.join(ROOT, root, specifier.slice(2)));
  } else if (specifier.startsWith(".")) {
    bases.push(path.resolve(path.dirname(fromFile), specifier));
  } else {
    return null;
  }
  for (const base of bases) {
    if (path.extname(base) !== "" && existsSync(base)) return base;
    for (const extension of MODULE_EXTENSIONS) {
      if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
    }
    for (const extension of MODULE_EXTENSIONS) {
      const index = path.join(base, `index${extension}`);
      if (existsSync(index)) return index;
    }
  }
  return null;
}

export function runCheckContractsTests() {
  const runnerSource = stripComments(readFileSync(path.join(ROOT, "tests", "run-tests.ts"), "utf8"));
  const pairs = [...runnerSource.matchAll(REGISTRATION)].map((match) => ({
    name: match[1],
    export: match[2],
  }));

  // A source-parsing check dies by matching NOTHING, not by going red — then it only proves that an
  // empty list equals an empty list. 2,139 registrations parsed when this was written.
  assert.ok(
    pairs.length > 2_000,
    `only ${pairs.length} runTest registrations parsed out of tests/run-tests.ts — the call shape changed and every assertion below has gone vacuous`,
  );

  assert.ok(CONTRACT_GATES.length > 0, "the contract-gate table is empty, so check:contracts would run nothing");

  // 1. Every gate in the table is a gate the suite really runs, reached through the same export.
  const unregistered: string[] = [];
  const misnamed: string[] = [];
  const unimported: string[] = [];
  for (const gate of CONTRACT_GATES) {
    const registered = pairs.filter((pair) => pair.export === gate.export);
    if (registered.length === 0) {
      unregistered.push(`${gate.slug} (${gate.export})`);
      continue;
    }
    if (!registered.some((pair) => pair.name.startsWith(gate.namePrefix))) {
      misnamed.push(`${gate.slug}: table says ${JSON.stringify(gate.namePrefix)}, run-tests.ts says ${JSON.stringify(registered[0].name.slice(0, gate.namePrefix.length))}`);
    }
    const expected = `import { ${gate.export} } from "./${path.basename(gate.file)}";`;
    if (!runnerSource.includes(expected)) unimported.push(expected);
  }
  assert.deepEqual(
    unregistered,
    [],
    "these contract gates are in scripts/check-contracts-gates.mjs but NO runTest call in tests/run-tests.ts uses their export — check:contracts would import a gate that nothing gates the merge with, or fail to import it at all",
  );
  assert.deepEqual(
    misnamed,
    [],
    "a gate's namePrefix no longer matches the name it is registered under in tests/run-tests.ts — update the table, since that prefix is what check:contracts prints",
  );
  assert.deepEqual(
    unimported,
    [],
    "these import lines are missing from tests/run-tests.ts, so the gate is registered under a different module than the table names",
  );

  // 2. The file and the symbol exist on disk. A typo here is a FAIL the script reports honestly,
  // but it is better caught in the suite than by a session mid-push.
  const missingFiles = CONTRACT_GATES.filter((gate) => !existsSync(path.join(ROOT, gate.file))).map((gate) => gate.file);
  assert.deepEqual(missingFiles, [], "a contract gate names a test file that does not exist");

  const notExported = CONTRACT_GATES.filter((gate) => {
    const source = readFileSync(path.join(ROOT, gate.file), "utf8");
    return !new RegExp(`export\\s+(?:async\\s+)?function\\s+${gate.export}\\b`).test(stripComments(source));
  }).map((gate) => `${gate.file} does not export ${gate.export}`);
  assert.deepEqual(notExported, [], "a contract gate names an export its test file does not have");

  // 3. THE OFFLINE RULE, and it is now TRANSITIVE — the whole import graph of every gate, not its
  // first two levels. Every gate here must be fs-plus-source-text: no Supabase client, no env bag,
  // no Next runtime.
  //
  // 🔴 WHY IT HAD TO BECOME TRANSITIVE. The last gate to join the table — `the Office-allocation
  // board row` — reaches its pure function through a NARROW WRAPPER MODULE
  // (src/lib/needs-you/office-allocation-drift-items.ts, lifted out of needs-you/sources.ts for
  // exactly this reason). With a two-level walk, a service import added one level below that
  // wrapper would put `getSupabaseAdmin` back in the process and this would still read green: the
  // invariant would hold on the day it was written and quietly stop holding later. The walk now
  // follows every specifier it can resolve — `@/…` the way tests/alias-loader.mjs resolves it,
  // relative hops from the importing file — with a `seen` set for the cycles a domain graph has,
  // and it names the whole trail so a breach says which hop introduced it.
  //
  // It is still not a proof of purity: a module can reach a client through a bare package or a
  // dynamic `await import(…)`, which no source walk sees. Judge a new gate by reading it.
  const breaches: string[] = [];
  for (const gate of CONTRACT_GATES) {
    const entry = path.join(ROOT, gate.file);
    const seen = new Set<string>([entry]);
    const queue: Array<{ file: string; trail: string }> = [{ file: entry, trail: gate.file }];
    while (queue.length > 0) {
      const { file, trail } = queue.shift()!;
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (NOT_OFFLINE.test(specifier)) {
          breaches.push(`${trail} imports ${specifier}`);
          continue;
        }
        const next = resolveModule(specifier, file);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        queue.push({ file: next, trail: `${trail} -> ${specifier}` });
      }
    }
  }
  assert.deepEqual(
    breaches,
    [],
    "a contract gate reaches a Supabase client, the env bag or the Next runtime, so it is not offline and does not belong in check:contracts — leave it to the PR's own validate",
  );

  // 4. The flags the child runs under. Asserted on the exported value, not on source text, because
  // this is the one that would do real damage: `--env-file-if-exists=.env.local` points at
  // PRODUCTION Supabase, and a check a session runs casually on every branch must never load it.
  assert.deepEqual(
    TS_NODE_FLAGS.filter((flag) => flag.includes("env-file")),
    [],
    "check:contracts must not pass --env-file-if-exists: .env.local holds PRODUCTION Supabase credentials, and these gates read files",
  );
  for (const flag of ["--experimental-strip-types", "--experimental-loader"]) {
    assert.ok(TS_NODE_FLAGS.includes(flag), `check:contracts needs ${flag} to import a .ts gate`);
  }

  const launcher = stripComments(readFileSync(path.join(ROOT, "scripts", "check-contracts.mjs"), "utf8"));
  assert.doesNotMatch(
    launcher,
    /env-file/,
    "scripts/check-contracts.mjs must not reintroduce an env file on its own",
  );
  assert.ok(
    launcher.includes("cwd: ROOT"),
    "the gate runner must be spawned with cwd pinned to the repo root — access-registry-coverage resolves app/api from process.cwd(), so a run from a subdirectory would measure a smaller tree and PASS",
  );
  assert.ok(existsSync(path.join(ROOT, GATE_RUNNER)), `GATE_RUNNER names a file that does not exist: ${GATE_RUNNER}`);

  // 4b. THE PER-COMMIT RECORD THE PRE-PUSH REMINDER READS. The owner widened that reminder to EVERY
  // push on 2026-10-23, so it needs a way to be satisfied: a clean full run writes a record for the
  // committed sha and the next push of that commit says nothing. Pinned on source because observing
  // the behaviour costs a real 8-second run — and because what can go wrong is not the writing but
  // the FORGETTING. A pass recorded, then a run that fails, then a push that stays quiet on the
  // strength of the stale record, is the one shape that makes the reminder worse than no reminder.
  assert.ok(
    launcher.includes("from './lib/check-contracts-record.mjs'"),
    "scripts/check-contracts.mjs must reach the per-commit record through scripts/lib/check-contracts-record.mjs — the writer and .claude/hooks/push-typecheck-guard.mjs's reader are deliberately one module",
  );
  for (const [code, why] of [
    ["2", "a NO VERDICT run"],
    ["1", "a FAILED gate"],
  ] as const) {
    assert.match(
      launcher,
      new RegExp(`forgetAnyRecordedPass\\(\\);\\s*process\\.exit\\(${code}\\);`),
      `${why} must clear this commit's recorded pass before exiting: the record decides whether the push guard says anything, and a stale one silences the reminder on a run that did not pass`,
    );
  }
  assert.match(
    launcher,
    /if \(skippedTools\.length === 0\) \{\s*const recorded = writeContractsPass\(/,
    "the pass is recorded ONLY inside the `skippedTools.length === 0` branch — a run where a tool gate was SKIPPED has not read every gate, and quieting the reminder on partial coverage is exactly what the skip line exists to prevent",
  );
  assert.match(
    launcher,
    /\} else \{\s*forgetAnyRecordedPass\(\);\s*\}/,
    "a run with a SKIPPED tool gate must clear whatever this commit held rather than leave an earlier full pass standing",
  );

  // 5. It is wired as a script and NOT into the `ci` chain. tests/ci-gate-parity.test.ts requires
  // every check:* named in `ci` to appear literally in a .github/workflows/*.yml file, and a CI
  // step would be waste anyway — the sharded suite already runs all of these.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts["check:contracts"],
    "node scripts/check-contracts.mjs",
    "package.json must expose check:contracts as a plain node launcher",
  );
  assert.doesNotMatch(
    pkg.scripts.ci,
    /check:contracts/,
    "check:contracts must stay out of the `ci` script: ci-gate-parity requires every check:* in `ci` to appear in a workflow file, and the suite already runs these gates",
  );

  // 6. The shard split covers every gate EXACTLY once, at every shard count.
  //
  // 🔴 THIS IS THE ONE THAT MATTERS MOST. A bad divisor does not fail — it is a SMALLER run
  // reporting success, which is strictly worse than not sharding (the lesson
  // scripts/run-tests-sharded.mjs was built on). So the parent refuses on coverage, and this proves
  // the split it refuses against.
  for (let total = 1; total <= MAX_CONTRACT_SHARDS + 1; total += 1) {
    const seen: string[] = [];
    for (let index = 1; index <= total; index += 1) {
      for (const gate of shardGates(CONTRACT_GATES, index, total)) seen.push(gate.slug);
    }
    assert.deepEqual(
      [...seen].sort(),
      CONTRACT_GATES.map((gate) => gate.slug).sort(),
      `the ${total}-shard split does not cover every contract gate exactly once`,
    );
  }

  // The expensive gates must not land together, or sharding buys nothing. These two are 8.2s and
  // 5.9s of a run whose other seven come to under 3s between them.
  const twoShards = [1, 2].map((index) => shardGates(CONTRACT_GATES, index, 2).map((gate) => gate.slug));
  const withNeutral = twoShards.findIndex((slugs) => slugs.includes("neutral-wording"));
  assert.ok(
    !twoShards[withNeutral].includes("access-registry-coverage"),
    "the two most expensive gates were packed into the same shard, which is the whole wall clock — shardGates must pack longest-first",
  );

  // 7. Coverage refusal actually refuses. Each of these is a way a sharded run lies.
  assert.deepEqual(
    coverageProblems(
      [{ index: 1, out: "PHX_CONTRACT_RESULT shard=1/1 ran=" + CONTRACT_GATES.map((gate) => gate.slug).join(",") }],
      1,
    ),
    [],
    "a complete single-shard run must report no coverage problems",
  );
  assert.ok(
    coverageProblems([{ index: 1, out: "PASS something (1ms)" }], 1).some((problem) => problem.includes("no PHX_CONTRACT_RESULT")),
    "a shard that printed no result line must be refused — that is what a killed or crashed shard looks like",
  );
  assert.ok(
    coverageProblems([{ index: 1, out: "PHX_CONTRACT_RESULT shard=1/1 ran=module-memory" }], 1).some((problem) =>
      problem.startsWith("no shard ran "),
    ),
    "a gate no shard ran must be refused, not reported as a pass",
  );
  assert.ok(
    coverageProblems([{ index: 1, out: "PHX_CONTRACT_RESULT shard=1/1 ran=module-memory,module-memory" }], 1).some(
      (problem) => problem.includes("ran in 2 shards"),
    ),
    "a gate run twice means the split is wrong and must be refused",
  );
  assert.ok(
    coverageProblems([{ index: 1, out: "PHX_CONTRACT_RESULT shard=1/1 ran=not-a-gate" }], 1).some((problem) =>
      problem.includes("unknown gate"),
    ),
    "a shard reporting a gate the table does not have must be refused",
  );
  assert.match(
    "PHX_CONTRACT_RESULT shard=2/3 ran=a,b",
    SHARD_RESULT_RE,
    "the shard result line and the regex that reads it must stay in step",
  );

  // 8. Shard sizing. MEMORY IS A CEILING AS WELL AS CPU: free RAM on the owner's laptop is
  // routinely under 2.5 GB, and mem-watchdog.ps1 reaps any node job under 500 MB free. A check run
  // casually on every branch must serialise itself rather than be the thing that trips that.
  assert.equal(
    contractShardCount(undefined, { cpus: () => 12, bytes: () => 300 * 1024 * 1024, gates: 9 }),
    1,
    "with almost no free memory the run must serialise, whatever the CPU count says",
  );
  assert.equal(
    contractShardCount(undefined, { cpus: () => 1, bytes: () => 32 * 1024 * 1024 * 1024, gates: 9 }),
    1,
    "more shards than CPUs is slower, not faster — each one re-pays the node and loader startup",
  );
  assert.equal(
    contractShardCount(undefined, { cpus: () => 12, bytes: () => 32 * 1024 * 1024 * 1024, gates: 9 }),
    MAX_CONTRACT_SHARDS,
    "on a big idle machine the shard count must reach its ceiling",
  );
  assert.equal(
    contractShardCount(undefined, { cpus: () => 12, bytes: () => 32 * 1024 * 1024 * 1024, gates: 2 }),
    2,
    "there must never be more shards than gates, or a shard runs nothing and still reports",
  );
  assert.equal(
    contractShardCount("1", { cpus: () => 12, bytes: () => 32 * 1024 * 1024 * 1024, gates: 9 }),
    1,
    "PHX_CONTRACT_SHARDS must override the sizing",
  );
  assert.throws(
    () => contractShardCount("0", { gates: 9 }),
    /positive integer/,
    "PHX_CONTRACT_SHARDS=0 must be refused, not silently read as serial",
  );
  assert.ok(CONTRACT_SHARD_BYTES > 0, "a shard's memory budget must be a positive number of bytes");

  // The lint child runs ALONGSIDE the shards, so its memory has to come out of the budget before
  // the shards are counted — otherwise a box with 1.6 GB free starts four node processes and
  // mem-watchdog.ps1 reaps one, which reports as a shard that printed nothing.
  assert.ok(TOOL_GATE_BYTES > 0, "the tool gate's memory reservation must be a positive number of bytes");
  assert.ok(
    contractShardCount(undefined, {
      cpus: () => 12,
      bytes: () => CONTRACT_SHARD_BYTES * 2 + TOOL_GATE_BYTES,
      gates: 9,
      reserveBytes: TOOL_GATE_BYTES,
    }) <
      contractShardCount(undefined, {
        cpus: () => 12,
        bytes: () => CONTRACT_SHARD_BYTES * 2 + TOOL_GATE_BYTES,
        gates: 9,
      }),
    "reserveBytes must actually reduce the shard count — a reservation the sizing ignores is not a reservation",
  );

  // 9. THE TOOL GATES. All 5 of the checks/Lint reds between 9 and 13 Oct 2026 were ESLint ERRORS on
  // files the PR had changed, and 4 more were `validate/Check migrations` — but neither is one of
  // the suite's exported functions, and folding either into CONTRACT_GATES would have meant
  // loosening section 1, the invariant that makes a PASS here mean what a PASS in `validate` means.
  assert.ok(TOOL_GATES.length > 0, "the tool-gate list must not be empty while the launcher reports it");
  const contractSlugs = new Set(CONTRACT_GATES.map((gate) => gate.slug));
  for (const gate of TOOL_GATES) {
    assert.ok(
      !contractSlugs.has(gate.slug),
      `tool gate ${gate.slug} shares a slug with a contract gate, so shard coverage and the lint would be counted as one thing`,
    );
    assert.ok(gate.what.length > 0, `tool gate ${gate.slug} must say what it does, for --list`);
    assert.ok(
      Number.isFinite(gate.reserveBytes) && gate.reserveBytes > 0,
      `tool gate ${gate.slug} must reserve a positive number of bytes — its child runs alongside the shards`,
    );
  }
  assert.equal(
    TOOL_GATE_BYTES,
    TOOL_GATES.reduce((sum, gate) => sum + gate.reserveBytes, 0),
    "TOOL_GATE_BYTES must be the SUM of the tool gates' reservations, or adding a gate silently starts an unbudgeted child",
  );

  // 🔴 EVERY TOOL GATE IN THE TABLE HAS A RUNNER IN THE LAUNCHER. The table is the published list —
  // `--list` prints it and docs/testing.md counts it — so a gate listed and never run is the one
  // shape where the summary would claim coverage the run does not have. The launcher refuses that
  // case (NO VERDICT, exit 2) rather than skipping quietly; this pins the wiring that makes the
  // refusal unnecessary.
  const unwired = TOOL_GATES.filter((gate) => !new RegExp(`["']${gate.slug}["']\\s*:\\s*run\\w+`).test(launcher)).map(
    (gate) => gate.slug,
  );
  assert.deepEqual(unwired, [], "a tool gate is listed with no runner wired in scripts/check-contracts.mjs");
  assert.match(
    launcher,
    /typeof TOOL_GATE_RUNNERS\[gate\.slug\] !== ['"]function['"]/,
    "the launcher must refuse a tool gate it cannot run (NO VERDICT), never report it as a skip",
  );

  // 10. THE MIGRATION GATE RUNS `validate`'s OWN SCRIPT — the three places that name it must agree,
  // because this gate's whole claim is that its PASS is the CI step's verdict and not a second
  // implementation of the migration rules.
  assert.ok(
    existsSync(path.join(ROOT, MIGRATION_CHECK_SCRIPT)),
    `the migration gate names ${MIGRATION_CHECK_SCRIPT}, which does not exist`,
  );
  assert.ok(
    pkg.scripts["check:migrations"]?.includes(MIGRATION_CHECK_SCRIPT),
    `package.json's check:migrations must run ${MIGRATION_CHECK_SCRIPT}, got "${pkg.scripts["check:migrations"]}"`,
  );
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(
    workflow,
    /run:\s*pnpm run check:migrations\b/,
    "ci.yml must still run `pnpm run check:migrations` — if that step is renamed or dropped, this tool gate is reproducing a step that no longer gates anything",
  );
  assert.match(
    launcher,
    /capture\(process\.execPath,\s*\[MIGRATION_CHECK_SCRIPT\]\)/,
    "the migration gate must SPAWN that script, never re-implement its rules in this file",
  );

  // 🔴 THE DETAIL IS THE **LAST** `[migration-check]` LINE, NOT THE FIRST. A passing run opens with
  // the cross-branch note, prints a WARN line per warning, and ends on the count summary. The
  // fixture below is that shape, and it is deliberately SYNTHETIC: the repo warned 8 times on every
  // run when this was written, then once #5853 annotated the seven DROP TABLE migrations only the
  // grandfathered duplicate timestamp was left, and since that collision was re-stamped away
  // (2026-10-13) the step runs at 0 warnings — a fixture copied from a live run would need editing
  // on every such change while proving nothing more. A first-match read reports "compared against
  // origin/main …" as the verdict of the step, which says nothing about whether it passed.
  assert.equal(
    migrationDetail(
      "[migration-check] cross-branch timestamp check compared against origin/main at 96c014e57 (10 min old), 867 migration(s) there.\n"
      + '[migration-check] WARN:  "20261012184500_x.sql" contains DROP TABLE or TRUNCATE\n'
      + "[migration-check] 867 migrations — 8 warning(s), 0 errors. Passing.\n",
    ),
    "867 migrations — 8 warning(s), 0 errors. Passing.",
    "the migration gate's detail must be the LAST [migration-check] line — the count summary — not the cross-branch note the run opens with",
  );
  assert.equal(
    migrationDetail("[migration-check] WARN:  only a warning, no summary\n"),
    null,
    "with no summary line the detail must be null so the caller falls back, rather than printing a warning as the verdict",
  );
  assert.equal(migrationDetail(""), null, "no output must read as no detail");

  // --quiet is the whole reason this is cheap AND safe: it reports errors only, which is exactly
  // what reddens the CI step, and it makes the known single-file trap inert, because "Unused
  // eslint-disable directive" is a WARNING — so linting a subset cannot manufacture a failure the
  // full run would not have had.
  const lintArgv = eslintArgs(["src/example.ts"], "/tmp/cache");
  assert.ok(lintArgv.includes("--quiet"), "the lint must report errors only — a warning has never reddened the CI step");
  assert.ok(
    lintArgv.includes("--cache") && lintArgv.includes("/tmp/cache"),
    "the lint must use its own cache location, which is what turns a 6.4s cold run into ~3s warm",
  );
  assert.equal(lintArgv[0], ESLINT_BIN, "eslint must be invoked through node, by path");
  assert.ok(
    !lintArgv.some((arg) => /\bpnpm\b/.test(arg)),
    "eslint must never be reached through pnpm — inside a worktree that purges the node_modules junction (bash-guard C6)",
  );

  // 🔴 THE CACHE LIVES OUTSIDE THE REPO, and is keyed by the checkout. An earlier draft wrote
  // `.eslintcache-contracts` into the repo root, which is not the gitignored name and showed up as
  // an untracked file; and one cache shared between worktrees would hand one tree's results to
  // another, since every worktree has the same file names.
  const cacheHere = lintCacheLocation(ROOT);
  assert.ok(
    !path.resolve(cacheHere).startsWith(path.resolve(ROOT) + path.sep),
    `the lint cache must not live inside the repo, got ${cacheHere}`,
  );
  assert.notEqual(
    lintCacheLocation(path.join(ROOT, "..", "_wt-other")),
    cacheHere,
    "two checkouts must not share one lint cache — their file names are identical and their contents are not",
  );

  // 🔴 THE DIFF IS AGAINST THE WORKING TREE. A session runs this BEFORE committing, so diffing
  // base..HEAD would lint the previous version of the work; and a brand-new route file is untracked
  // until it is added, which is exactly the change that goes red.
  const [diffArgs, untrackedArgs] = changedFileCommands("abc1234");
  assert.deepEqual(
    diffArgs,
    ["diff", "--name-only", "--diff-filter=ACMR", "abc1234"],
    "the changed-file diff must be base-to-working-tree, with no ...HEAD and no --cached",
  );
  assert.deepEqual(
    untrackedArgs,
    ["ls-files", "--others", "--exclude-standard"],
    "untracked files must be included — a new app/api route is untracked until it is added",
  );

  // 🛑 mobile/ is frozen (AGENTS.md §4) and its Expo typecheck reports separately without gating a
  // merge, so a mobile file has nothing to say here.
  assert.deepEqual(
    lintableChangedFiles([
      "src/a.ts\napp/b.tsx\nscripts/c.mjs\n",
      "mobile/app/d.tsx\ndocs/e.md\nsrc/a.ts\nxlsx/f.xlsx\n",
    ]),
    ["app/b.tsx", "scripts/c.mjs", "src/a.ts"],
    "the lint set must drop mobile/, drop files eslint has no rules for, and never list one file twice",
  );
  assert.deepEqual(lintableChangedFiles([""]), [], "an empty diff must lint nothing rather than the whole repo");
  assert.ok(MAX_LINT_FILES > 0, "the lint file cap must be a positive number");

  // 10. IT SAYS WHAT IT CANNOT DO. 14 of the 17 checks/Typecheck reds were ordinary type errors
  // only a compiler finds. A run that read as "the types are fine" while covering 3 of 17 would buy
  // a confidence it has not earned — so the note is printed on every run, pass or fail.
  assert.match(
    TYPECHECK_NOTE,
    /remote-check\.mjs typecheck/,
    "the note must name the command that DOES check types, not merely disclaim",
  );
  assert.ok(
    launcher.includes("TYPECHECK_NOTE"),
    "the launcher must print the typecheck note — a disclaimer nothing prints is not a disclaimer",
  );
}
