// The decisions `scripts/run-tests-sharded.mjs` makes, with no child processes in them.
//
// WHY A SECOND FILE. The runner's job is to spawn N copies of the unit suite and refuse unless they
// between them ran every test exactly once. That refusal is the entire point of sharding — without
// it, a bad divisor or a shard that dies after its last test is a SMALLER suite reporting success,
// which is strictly worse than not sharding at all. But the runner cannot be imported to test it:
// its top-level body spawns the shards, so `import`ing it from the suite would run the suite.
//
// So the pure half lives here and the runner imports it, the same split `scripts/remote-check.mjs`
// and `scripts/remote-check-plan.mjs` already use in this repo and for the same reason. Pinned by
// `tests/run-tests-sharded.test.ts`.

import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";

/** Memory a new process can actually get, from MemAvailable, falling back to `os.freemem()`. */
export function availableBytes() {
  try {
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (kb) return Number(kb[1]) * 1024;
  } catch {
    // Not Linux, or /proc is not mounted — fall through to the portable reading.
  }
  return freemem();
}

/** Resident set a single shard needs: the whole module graph, measured at 1.4–1.7 GB. */
export const SHARD_BYTES = 1.8 * 1024 * 1024 * 1024;

/** The hard ceiling on shards, whatever the machine reports. */
export const MAX_SHARDS = 4;

/**
 * How many shards to run. `PHX_TEST_SHARDS` overrides; otherwise the smaller of the CPU and the
 * memory ceiling, capped at {@link MAX_SHARDS}.
 *
 * More shards than CPUs is slower, not faster — each one re-pays the whole ~8s import.
 *
 * 🔴 AND MEMORY IS THE OTHER CEILING, BECAUSE THIS REPO'S RUNNERS ARE 7 GB, NOT 16. The first
 * version of this cap said "4, because a hosted runner has 16 GB" — that is the PUBLIC repo tier.
 * This repository is private (`gh api repos/<owner>/<repo>` → `"private": true`), whose standard
 * Linux runner is 2 vCPU / 7 GB, and the self-hosted preview box is 7.7 GB. A 4-shard run peaks at
 * 5.6 GB of total RSS, measured. On today's 2-vCPU hosted runner the CPU ceiling bites first and
 * nothing is at risk — but `CI_SELF_HOSTED` is one variable away from putting this on the 4-core box
 * beside a typecheck that peaks at 5.06 GB, and the typecheck lock does not cover the suite. That is
 * an OOM kill of a REQUIRED check, which on `main` is the production deploy gate.
 *
 * MemAvailable, not `os.freemem()`: freemem is MemFree, which counts the page cache as used and on a
 * warm runner reads near zero. Believing it would serialise the suite and quietly give back every
 * second this script exists to save.
 *
 * 🔴 IT TAKES THE VALUE OF `PHX_TEST_SHARDS`, NEVER `process.env` ITSELF. Next declares `NODE_ENV`
 * as REQUIRED on `NodeJS.ProcessEnv`, so a test cannot hand this function a `{}` or a
 * `{ PHX_TEST_SHARDS: "3" }` literal without TS2741, and the narrow stand-in hits the weak-type rule
 * from the other side — the repo note is `a-test-can-never-hand-a-function-a-process-env-literal`.
 * Taking the one value keeps the seam testable with no cast and no fixture.
 *
 * @param {string | undefined} override the raw `PHX_TEST_SHARDS` value, or undefined
 * @param {{ cpus?: () => number, bytes?: () => number }} [probes] injection seam for the test
 */
export function shardCount(override, probes = {}) {
  if (override !== undefined && override !== "") {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1) throw new Error(`PHX_TEST_SHARDS must be a positive integer, got ${override}`);
    return n;
  }
  const cpus = (probes.cpus ?? availableParallelism)();
  const byMemory = Math.floor(((probes.bytes ?? availableBytes)() * 0.8) / SHARD_BYTES);
  return Math.max(1, Math.min(MAX_SHARDS, cpus, byMemory));
}

/** `PHX_SHARD_RESULT shard=i/n seen=S ran=R`, or null when the shard never printed one. */
export function parseResult(output) {
  const line = /^PHX_SHARD_RESULT shard=(\d+)\/(\d+) seen=(\d+) ran=(\d+)$/m.exec(output);
  if (!line) return null;
  return { index: Number(line[1]), total: Number(line[2]), seen: Number(line[3]), ran: Number(line[4]) };
}

/** The "N test files passed in Mms. Slowest:" block each shard prints, as [ms, name] pairs. */
export function parseSlowest(output) {
  const rows = [];
  for (const match of output.matchAll(/^ {2}(\d+)ms {2}(.+)$/gm)) rows.push([Number(match[1]), match[2]]);
  return rows;
}

/**
 * Everything wrong with a finished run, as human sentences. Empty means the shards between them ran
 * every declared test exactly once.
 *
 * @param {Array<{ index: number, out: string, code?: number, signal?: string|null, spawnError?: Error }>} results
 * @param {number} total
 */
export function collectProblems(results, total) {
  const problems = [];
  for (const result of results) {
    if (result.spawnError) problems.push(`shard ${result.index} could not start: ${result.spawnError.message}`);
    else if (result.signal) problems.push(`shard ${result.index} was killed by ${result.signal}`);
    else if (result.code !== 0) problems.push(`shard ${result.index} exited ${result.code}`);
  }

  // 🔴 COVERAGE IS ONLY ASKED WHEN NOTHING ALREADY FAILED. `tests/run-tests.ts` rethrows on the first
  // failing test, so a shard with a red test stops there and its counts are legitimately short —
  // reporting that as a coverage breach too would bury the one line that matters (which test failed)
  // under two that are consequences of it, and would train a reader to discount this check. A failing
  // shard is already a failing run; coverage is the question you ask when every shard passed.
  if (problems.length > 0) return problems;

  const parsed = results.map((result) => ({ index: result.index, result: parseResult(result.out) }));
  const missing = parsed.filter((entry) => entry.result === null).map((entry) => entry.index);
  if (missing.length > 0) {
    problems.push(
      `shard(s) ${missing.join(", ")} printed no PHX_SHARD_RESULT line, so this run cannot prove which ` +
        `tests executed. Treat it as a failure: a shard that dies between its last test and its exit ` +
        `handler looks exactly like one that passed.`,
    );
    return problems;
  }

  const reported = parsed.map((entry) => entry.result);
  const seenValues = new Set(reported.map((entry) => entry.seen));
  if (seenValues.size !== 1) {
    problems.push(
      `the shards disagree about how many tests the runner declares (${[...seenValues].join(", ")}). ` +
        `Every shard imports and walks the whole of tests/run-tests.ts, so this can only mean they ` +
        `ran different code — a stale worktree, or a shard reading a different checkout.`,
    );
  }
  const indices = new Set(reported.map((entry) => entry.index));
  if (indices.size !== total) problems.push(`expected shard indices 1..${total}, got ${[...indices].sort().join(", ")}`);
  const seen = reported[0].seen;
  const ran = reported.reduce((sum, entry) => sum + entry.ran, 0);
  if (ran !== seen) {
    problems.push(
      `the shards ran ${ran} of ${seen} tests. Every test must run in exactly one shard; a gap here ` +
        `is a suite that silently shrank, which is the whole reason this check exists.`,
    );
  }
  return problems;
}

/** How many tests a clean run executed, for the summary line. */
export function ranTotal(results) {
  return results.reduce((sum, result) => sum + (parseResult(result.out)?.ran ?? 0), 0);
}
