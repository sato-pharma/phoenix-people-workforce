// The shard runner's coverage refusal — the guard that makes sharding safe at all.
//
// WHY THIS EXISTS. `pnpm run test:sharded` splits the unit suite across N processes, and it is the
// step the required `validate` (pull request) and `checks` (everything else) jobs run. Splitting a
// suite has one catastrophic failure mode and it is silent: if the split drops tests — a bad
// divisor, two shards handed the same index, a shard that dies between its last test and its exit
// handler — then a SMALLER suite passes and every check goes green. That is strictly worse than not
// sharding, because the gate still looks like a gate. On `main` it is the production deploy gate.
//
// `collectProblems` is the only thing standing between that and a green merge, and until now
// nothing asserted it. It is run on every CI run and was pinned by no test: the four branches below
// were verified by hand once and would have rotted from there.
//
// Each case is written so that it FAILS if the branch is deleted — the assertion is on the refusal,
// never merely on "some problem was reported".

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_SHARDS,
  collectProblems,
  parseResult,
  parseSlowest,
  ranTotal,
  shardCount,
} from "../scripts/run-tests-sharded-plan.mjs";

/** A shard that exited cleanly having seen `seen` tests and run `ran` of them. */
function shard(index: number, total: number, seen: number, ran: number) {
  return { index, code: 0, signal: null, out: `PASS something\nPHX_SHARD_RESULT shard=${index}/${total} seen=${seen} ran=${ran}\n` };
}

export function runRunTestsShardedTests() {
  // ── 1. The happy path, so every refusal below is known to be about its own branch ────────────
  {
    const problems = collectProblems([shard(1, 2, 2253, 1127), shard(2, 2, 2253, 1126)], 2);
    assert.deepEqual(problems, [], "two shards covering 2,253 of 2,253 tests must be accepted");
    assert.equal(ranTotal([shard(1, 2, 2253, 1127), shard(2, 2, 2253, 1126)]), 2253);
  }

  // ── 2. A shard that printed no marker is a REFUSAL, not an assumed pass ──────────────────────
  // This is the shape the whole check exists for: a process killed after its last test but before
  // its `exit` handler exits 0 with a full-looking PASS list and no marker.
  {
    const silent = { index: 2, code: 0, signal: null, out: "PASS something\nPASS something-else\n" };
    // Called through a try so that deleting the branch reports THIS case rather than a bare
    // TypeError from the arithmetic below it reading a null result — "the suite went red" has been
    // red for the wrong reason here before.
    let problems: string[];
    try {
      problems = collectProblems([shard(1, 2, 2253, 1127), silent], 2);
    } catch (error) {
      throw new Error(
        "collectProblems THREW on a shard that printed no PHX_SHARD_RESULT line (" +
          (error instanceof Error ? error.message : String(error)) +
          ") instead of naming it. A crash is still a non-zero exit, but the operator is told nothing " +
          "about which shard went silent, which is the one fact they need.",
      );
    }
    assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
    assert.match(
      problems[0],
      /shard\(s\) 2 printed no PHX_SHARD_RESULT line/,
      "a shard with no marker must be refused by name — accepting it is a suite that silently shrank",
    );
  }

  // ── 3. The ran counts not summing to seen is a REFUSAL ───────────────────────────────────────
  // The arithmetic failure: 2,253 declared, 2,252 executed. One test vanished.
  {
    const problems = collectProblems([shard(1, 2, 2253, 1127), shard(2, 2, 2253, 1125)], 2);
    assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
    assert.match(
      problems[0],
      /the shards ran 2252 of 2253 tests/,
      "a short ran-sum must be refused with both numbers — this is the arithmetic the check is for",
    );
  }

  // ── 4. Shards disagreeing about `seen` is a REFUSAL ──────────────────────────────────────────
  // Two shards walking different code. The sum can still be right, which is why `seen` is compared
  // on its own rather than inferred from the total.
  {
    const problems = collectProblems([shard(1, 2, 2253, 1127), shard(2, 2, 2240, 1126)], 2);
    assert.ok(
      problems.some((problem) => /disagree about how many tests the runner declares/.test(problem)),
      `shards reporting different seen counts must be refused, got ${JSON.stringify(problems)}`,
    );
  }

  // ── 5. Duplicate indices are a REFUSAL even when the arithmetic adds up ──────────────────────
  // Two shards both told they are 1/2 run the same half twice. seen matches, ran sums to seen, and
  // half the suite never ran. Only the index check sees this.
  {
    const problems = collectProblems([shard(1, 2, 2253, 1127), shard(1, 2, 2253, 1126)], 2);
    assert.ok(
      problems.some((problem) => /expected shard indices 1\.\.2/.test(problem)),
      `two shards reporting the same index must be refused, got ${JSON.stringify(problems)}`,
    );
  }

  // ── 6. A process-level failure is reported ALONE, and coverage is not asked ──────────────────
  // tests/run-tests.ts rethrows on the first failing test, so a red shard's counts are legitimately
  // short. Reporting that as a coverage breach too would bury the line that matters.
  {
    const red = { index: 2, code: 1, signal: null, out: "FAIL something\n" };
    const problems = collectProblems([shard(1, 2, 2253, 1127), red], 2);
    assert.deepEqual(problems, ["shard 2 exited 1"], "a failing shard must report once, without a coverage complaint");

    const killed = { index: 1, code: null as unknown as number, signal: "SIGKILL", out: "" };
    assert.deepEqual(collectProblems([killed], 1), ["shard 1 was killed by SIGKILL"], "an OOM kill must be named");

    const unstartable = { index: 1, code: 1, signal: null, out: "", spawnError: new Error("ENOENT") };
    assert.deepEqual(collectProblems([unstartable], 1), ["shard 1 could not start: ENOENT"]);
  }

  // ── 7. The marker parser is anchored, so a test NAME cannot forge one ────────────────────────
  {
    assert.equal(parseResult("PHX_SHARD_RESULT shard=1/2 seen=10 ran=5\n")?.ran, 5);
    assert.equal(parseResult("PASS a PHX_SHARD_RESULT shard=1/2 seen=10 ran=5\n"), null, "the marker must own its line");
    assert.equal(parseResult("nothing here\n"), null);
    assert.deepEqual(parseSlowest("  42ms  tests/foo.test.ts\n  7ms  tests/bar.test.ts\n"), [
      [42, "tests/foo.test.ts"],
      [7, "tests/bar.test.ts"],
    ]);
  }

  // ── 8. The shard count is bounded by memory as well as CPUs ──────────────────────────────────
  // 🔴 THE MEMORY CEILING IS NOT DECORATION. Each shard holds the whole module graph (~1.4-1.7 GB
  // measured) and this repo is PRIVATE, so its hosted runner is 2 vCPU / 7 GB — not the 16 GB of the
  // public tier that the first version of this cap assumed. `CI_SELF_HOSTED` is one variable away
  // from putting the suite on the 7.7 GB preview box beside a typecheck measured at 5.06 GB peak,
  // and the typecheck lock does not cover the suite. Four shards there is an OOM kill of a required
  // check — on `main`, the production deploy gate.
  {
    const gb = (n: number) => n * 1024 * 1024 * 1024;
    assert.equal(shardCount(undefined, { cpus: () => 8, bytes: () => gb(64) }), MAX_SHARDS, "the hard cap still applies");
    assert.equal(shardCount(undefined, { cpus: () => 2, bytes: () => gb(64) }), 2, "never more shards than CPUs");
    assert.equal(
      shardCount(undefined, { cpus: () => 4, bytes: () => gb(3) }),
      1,
      "a 4-core box with 3 GB free must run ONE shard — four would be an OOM kill of a required check",
    );
    assert.equal(shardCount(undefined, { cpus: () => 4, bytes: () => gb(0) }), 1, "never zero shards, whatever memory says");
    assert.equal(
      shardCount("3", { cpus: () => 1, bytes: () => gb(1) }),
      3,
      "an explicit PHX_TEST_SHARDS overrides both ceilings",
    );
    assert.throws(() => shardCount("0"), /positive integer/);
    assert.throws(() => shardCount("two"), /positive integer/);
  }

  // ── 9. The runner must still USE the refusal — importing it is not running it ─────────────────
  {
    const runner = readFileSync(resolve("scripts/run-tests-sharded.mjs"), "utf8");
    assert.match(runner, /collectProblems\(results, total\)/, "the runner no longer asks for the coverage verdict");
    assert.match(
      runner,
      /if \(problems\.length > 0\) \{[\s\S]*?process\.exit\(1\)/,
      "the runner must exit non-zero on a problem — a refusal nobody acts on is not a refusal",
    );
  }
}
