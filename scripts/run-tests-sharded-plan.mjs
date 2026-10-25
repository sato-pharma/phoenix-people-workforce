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
 * every declared test exactly once — or, in PART mode, that this part's own shards ran exactly the
 * slice they were handed and agree with each other. A part cannot prove the whole suite: only
 * {@link coverageProblems}, over every part's record, can.
 *
 * @param {Array<{ index: number, out: string, code?: number, signal?: string|null, spawnError?: Error }>} results
 * @param {number} total the GLOBAL shard total every shard was told (parts × shards per part in part mode)
 * @param {{ first: number, count: number }} [window] part mode: the global indices this process owns,
 *   `first..first+count-1`. Omitted means the process owns all of `1..total` and the ran-sum is asked.
 */
export function collectProblems(results, total, window) {
  const problems = [];
  for (const result of results) {
    if (result.spawnError) problems.push(`shard ${result.index} could not start: ${result.spawnError.message}`);
    else if (result.signal) problems.push(`shard ${result.index} was killed by ${result.signal}`);
    else if (result.code !== 0) problems.push(`shard ${result.index} exited ${result.code}`);
  }

  // 🔴 COVERAGE IS ONLY ASKED WHEN NOTHING ALREADY FAILED. Since 26 Oct 2026 `tests/run-tests.ts`
  // records a failing test and carries on, so a red shard's counts are usually whole — but a crash
  // OUTSIDE a test (a throw at import, a top-level await that rejects, an OOM kill) still ends it
  // short. Reporting that as a coverage breach too would bury the line that matters (which test
  // failed, printed as FAIL by the shard itself) under consequences of it, and would train a reader
  // to discount this check. A failing shard is already a failing run; coverage is the question you
  // ask when every shard passed.
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
  // A shard reports the total it was TOLD, so a different one means the divisor was not what the
  // runner computed. In part mode that is the number the other parts partition by, so it matters more.
  const totals = new Set(reported.map((entry) => entry.total));
  if (totals.size !== 1 || !totals.has(total)) {
    problems.push(`the shards reported a total of ${[...totals].join(", ")} but this run partitions by ${total}`);
  }
  const first = window?.first ?? 1;
  const count = window?.count ?? total;
  const wanted = Array.from({ length: count }, (_, i) => first + i);
  const indices = new Set(reported.map((entry) => entry.index));
  if (indices.size !== count || wanted.some((index) => !indices.has(index))) {
    problems.push(`expected shard indices ${first}..${first + count - 1}, got ${[...indices].sort((a, b) => a - b).join(", ")}`);
  }
  const seen = reported[0].seen;
  const ran = reported.reduce((sum, entry) => sum + entry.ran, 0);
  // 🔴 A PART SKIPS THE SUM ON PURPOSE — it ran a slice, so `ran` is legitimately short of `seen`.
  // The sum is asked of ALL the records together, by coverageProblems, and the run is not green
  // without it. Never skip it in a process that owns the whole range.
  if (window === undefined && ran !== seen) {
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

/**
 * `PHX_TEST_PART=p/P` → `{ part, parts }`, or null when unset. Part mode is how the suite is spread
 * over several CI JOBS: each job runs one part, and `scripts/ci-unit-coverage.mjs` proves the parts
 * together ran every test exactly once.
 *
 * @param {string | undefined} raw
 */
export function parsePart(raw) {
  if (raw === undefined || raw === "") return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  const part = match ? Number(match[1]) : 0;
  const parts = match ? Number(match[2]) : 0;
  if (!match || part < 1 || parts < 1 || part > parts) {
    throw new Error(`PHX_TEST_PART must look like 2/3 (part 2 of 3), got ${raw}`);
  }
  return { part, parts };
}

/**
 * The slice of the GLOBAL shard space part `part` of `parts` owns when each part runs `local`
 * shards: the total is `parts × local`, and this part owns `(part-1)×local+1 .. part×local`.
 *
 * tests/run-tests.ts deals each `runTest` call to exactly one of `total` shards (tests/shard-deal.ts,
 * the same answer in every process), so ANY total partitions the suite and these windows tile it
 * exactly, with no gap and no overlap.
 */
export function partWindow(part, parts, local) {
  return { total: parts * local, first: (part - 1) * local + 1, count: local };
}

/**
 * Everything wrong with the set of part records `checks` downloaded, as sentences. Empty means the
 * parts are exactly 1..P of one total, every shard everywhere saw the same number of tests, and the
 * tests the parts ran add up to that number — every test, exactly once.
 *
 * 🔴 THIS IS THE OTHER HALF OF {@link collectProblems}'s PART MODE, AND WITHOUT IT A PART'S GREEN
 * PROVES NOTHING ABOUT THE SUITE. A leg that never ran, a leg run twice and a wrong divisor each
 * leave every part individually green. Run on the records, they are named failures.
 *
 * @param {Array<{ part: number, parts: number, perPart: number, seen: number, ran: number }>} records
 */
export function coverageProblems(records) {
  const problems = [];
  if (records.length === 0) return ["no unit-suite coverage record was found, so nothing proves any test ran"];
  const partsValues = new Set(records.map((record) => record.parts));
  if (partsValues.size !== 1) {
    return [`the records disagree about how many parts the suite was split into (${[...partsValues].join(", ")})`];
  }
  const parts = records[0].parts;
  const have = records.map((record) => record.part).sort((a, b) => a - b);
  const wanted = Array.from({ length: parts }, (_, i) => i + 1);
  if (have.length !== parts || wanted.some((part, i) => have[i] !== part)) {
    problems.push(`expected exactly one record for each of parts 1..${parts}, got ${have.join(", ")}`);
  }
  const perPartValues = new Set(records.map((record) => record.perPart));
  if (perPartValues.size !== 1) {
    problems.push(`the parts ran different numbers of shards (${[...perPartValues].join(", ")}), so their windows do not tile the suite`);
  }
  const seenValues = new Set(records.map((record) => record.seen));
  if (seenValues.size !== 1) {
    problems.push(`the parts disagree about how many tests the runner declares (${[...seenValues].join(", ")})`);
  }
  if (problems.length > 0) return problems;
  const seen = records[0].seen;
  const ran = records.reduce((sum, record) => sum + record.ran, 0);
  if (ran !== seen) {
    problems.push(
      `the parts ran ${ran} of ${seen} tests. Every test must run in exactly one part; a gap here is a ` +
        `suite that silently shrank, and an overshoot is a test run twice.`,
    );
  }
  return problems;
}
