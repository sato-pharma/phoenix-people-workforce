#!/usr/bin/env node
// Run the unit suite as N parallel shards of ONE process each, and refuse unless the shards between
// them ran every test exactly once.
//
// WHY. `tests/run-tests.ts` is one node process executing ~2,250 `await runTest(...)` calls in
// series. It is the slowest step of the required `validate` check and nothing in it is parallel,
// while the runner it sits on has several idle CPUs. Measured 2026-10-06 on a 2-vCPU box, same
// tree, same commit: serial 213s, two shards 129s, three shards 144s. Two shards on two CPUs is the
// optimum because each shard still pays the full ~8s import of all 2,175 test modules (see the
// SHARDING note in tests/run-tests.ts for why the filter is at the call and not the import), so
// more shards than CPUs buys contention and pays that cost again.
//
// 🔴 THE COVERAGE CHECK IS THE POINT, NOT THE SPEED. A shard runner that merely waits on N children
// turns any mistake in the split — a bad divisor, a child that died between its last test and its
// exit, two children handed the same index — into a SMALLER suite reporting success, which is
// strictly worse than not sharding at all. So each shard prints `PHX_SHARD_RESULT shard=i/n seen=S
// ran=R` from an `exit` handler, and this script refuses unless every shard saw the same S, the
// R's sum to it, and every index 1..n reported. A missing line is itself a refusal.
//
// 🔴 AND IT RUNS THE `test` SCRIPT'S OWN COMMAND, read out of package.json rather than copied here.
// That script carries five node flags — `--env-file-if-exists=.env.local`,
// `--experimental-strip-types`, `--experimental-specifier-resolution=node`, the alias loader, and
// the runner path — and a second copy of them is a thing to drift. If `test` ever stops being a
// plain `node ...` invocation this script says so and exits rather than guessing.
//
// Usage:  node scripts/run-tests-sharded.mjs          (shards = CPUs, capped by free memory, max 4)
//         PHX_TEST_SHARDS=1 node scripts/run-tests-sharded.mjs   (one shard = the serial run)

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectProblems, parseSlowest, ranTotal, shardCount } from "./run-tests-sharded-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The `test` script's argv, from package.json. Returns the args AFTER `node`.
 *
 * Deliberately strict: anything that is not a single `node ...` command (a shell chain, another
 * runner, an env prefix) is refused rather than approximated, because the failure mode of guessing
 * is a shard that runs a DIFFERENT suite and still reports success.
 */
function testScriptArgs() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const script = String(pkg.scripts?.test ?? "").trim();
  if (!script) throw new Error("package.json has no `test` script");
  if (/[|&;<>]|\$\(/.test(script)) {
    throw new Error(
      `package.json's \`test\` script is no longer a single node command, so this runner cannot ` +
        `reproduce it safely: ${JSON.stringify(script)}. Update scripts/run-tests-sharded.mjs ` +
        `deliberately rather than letting it guess.`,
    );
  }
  const args = script.split(/\s+/);
  if (args[0] !== "node") {
    throw new Error(
      `package.json's \`test\` script must start with \`node\` for this runner to shard it; it reads ` +
        `${JSON.stringify(script)}.`,
    );
  }
  return args.slice(1);
}

async function runShard(args, index, total) {
  return new Promise((resolveShard) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, PHX_TEST_SHARD: `${index}/${total}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const tag = total === 1 ? "" : `[shard ${index}/${total}] `;
    const pump = (stream, sink) => {
      let partial = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        out += chunk;
        partial += chunk;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        // FAIL and the stack behind it are what a reader needs immediately; PASS lines are noise at
        // 2,000 a run, so they are counted and summarised instead.
        for (const line of lines) if (!line.startsWith("PASS ")) sink.write(`${tag}${line}\n`);
      });
      stream.on("end", () => {
        if (partial) sink.write(`${tag}${partial}\n`);
      });
    };
    pump(child.stdout, process.stdout);
    pump(child.stderr, process.stderr);
    child.on("error", (error) => resolveShard({ index, code: 1, out, spawnError: error }));
    child.on("close", (code, signal) => resolveShard({ index, code: code ?? 1, signal, out }));
  });
}

const args = testScriptArgs();
const total = shardCount(process.env.PHX_TEST_SHARDS);
const startedAt = Date.now();
console.log(
  `run-tests-sharded: ${total} shard(s) of \`${["node", ...args].join(" ")}\`` +
    (total === 1 ? " (one shard — identical to `pnpm run test`)" : ""),
);

const results = await Promise.all(Array.from({ length: total }, (_, i) => runShard(args, i + 1, total)));
const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

const problems = collectProblems(results, total);

if (problems.length === 0) {
  const ran = ranTotal(results);
  console.log(`\n${ran} test files passed in ${wallSeconds}s wall clock across ${total} shard(s).`);
  const slowest = results
    .flatMap((result) => parseSlowest(result.out))
    .sort((a, b) => b[0] - a[0])
    .slice(0, 10);
  if (slowest.length > 0) {
    console.log("Slowest:");
    for (const [ms, name] of slowest) console.log(`  ${ms}ms  ${name}`);
  }
}

if (problems.length > 0) {
  console.error(`\nrun-tests-sharded FAILED after ${wallSeconds}s:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
