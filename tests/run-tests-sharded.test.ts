// The shard runner's coverage refusal — the guard that makes sharding safe at all.
//
// WHY THIS EXISTS. `pnpm run test:sharded` splits the unit suite across N processes, and it is the
// step ci.yml's `unit` job runs (two parts of two shards since 2026-10-23) — the job the required `checks`
// status stands for. Splitting a
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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import {
  MAX_SHARDS,
  collectProblems,
  coverageProblems,
  createHangWatch,
  hangLimitMs,
  isTestMarker,
  parsePart,
  parseResult,
  parseSlowest,
  partWindow,
  ranTotal,
  shardCount,
} from "../scripts/run-tests-sharded-plan.mjs";
import { runShard } from "../scripts/run-tests-sharded-shard.mjs";
import { DEFAULT_TEST_MS, KNOWN_SLOW_TESTS_MS, createShardDeal } from "./shard-deal.ts";

/** A shard that exited cleanly having seen `seen` tests and run `ran` of them. */
function shard(index: number, total: number, seen: number, ran: number) {
  return { index, code: 0, signal: null, out: `PASS something\nPHX_SHARD_RESULT shard=${index}/${total} seen=${seen} ran=${ran}\n` };
}

export async function runRunTestsShardedTests() {
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
  // A red shard can end short of its slice (a crash outside a test still ends tests/run-tests.ts
  // early). Reporting that as a coverage breach too would bury the line that matters.
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
    assert.match(runner, /collectProblems\(results, total, window\)/, "the runner no longer asks for the coverage verdict");
    assert.match(
      runner,
      /if \(problems\.length > 0\) \{[\s\S]*?process\.exit\(1\)/,
      "the runner must exit non-zero on a problem — a refusal nobody acts on is not a refusal",
    );
  }

  // ── 10. PART MODE — the suite spread over CI jobs (2026-10-19) ───────────────────────────────
  // Each job runs one part. The parts' windows must TILE the global shard space exactly, or a test is
  // dropped or run twice while every part is individually green.
  {
    assert.equal(parsePart(undefined), null);
    assert.equal(parsePart(""), null);
    assert.deepEqual(parsePart("2/3"), { part: 2, parts: 3 });
    for (const bad of ["0/3", "4/3", "2", "a/b", "2/0", "1/2/3", " 1/2"]) {
      assert.throws(() => parsePart(bad), /PHX_TEST_PART must look like/, `"${bad}" must be refused`);
    }

    // Tiling: for several (parts, local) pairs, every global index 1..total is owned by exactly one part.
    for (const [parts, local] of [[3, 2], [1, 4], [4, 1], [5, 3]] as const) {
      const owners = new Map<number, number>();
      for (let part = 1; part <= parts; part += 1) {
        const window = partWindow(part, parts, local);
        assert.equal(window.total, parts * local);
        for (let i = 0; i < window.count; i += 1) {
          const index = window.first + i;
          assert.equal(owners.has(index), false, `global shard ${index} is owned by two parts at ${parts}x${local}`);
          owners.set(index, part);
        }
      }
      assert.equal(owners.size, parts * local, `the windows do not cover all ${parts * local} global shards at ${parts}x${local}`);
    }

    // A part's own check: its slice, told the global total, accepted WITHOUT the ran-sum.
    const window = { first: 3, count: 2 };
    assert.deepEqual(collectProblems([shard(3, 6, 2253, 380), shard(4, 6, 2253, 376)], 6, window), [], "a clean part must be accepted");
    // …and the sum is skipped only because it is a slice: a full run with the same short counts is refused.
    assert.ok(
      collectProblems([shard(1, 2, 2253, 380), shard(2, 2, 2253, 376)], 2).some((problem) => /the shards ran 756 of 2253/.test(problem)),
      "outside part mode the ran-sum must still be asked",
    );
    // A part handed the wrong window (two shards both claiming 3) is refused by index.
    assert.ok(
      collectProblems([shard(3, 6, 2253, 380), shard(3, 6, 2253, 376)], 6, window).some((p) => /expected shard indices 3\.\.4/.test(p)),
      "a part whose shards report the wrong indices must be refused",
    );
    // A shard reporting a different global total than the part was told is refused.
    assert.ok(
      collectProblems([shard(3, 4, 2253, 380), shard(4, 4, 2253, 376)], 6, window).some((p) => /partitions by 6/.test(p)),
      "a shard that reports a different divisor than the part computed must be refused",
    );
  }

  // ── 11. THE COVERAGE VERDICT over every part's record — the half a part cannot do ────────────
  {
    const rec = (part: number, ran: number, over: Partial<{ parts: number; perPart: number; seen: number }> = {}) => ({
      part,
      parts: over.parts ?? 3,
      perPart: over.perPart ?? 2,
      seen: over.seen ?? 2253,
      ran,
    });
    assert.deepEqual(coverageProblems([rec(1, 751), rec(2, 751), rec(3, 751)]), [], "three parts covering 2,253 of 2,253 must be accepted");
    assert.deepEqual(coverageProblems([rec(3, 751), rec(1, 751), rec(2, 751)]), [], "record order must not matter");

    assert.ok(coverageProblems([]).some((p) => /no unit-suite coverage record/.test(p)), "no records at all is a refusal, never a pass");
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751)]).some((p) => /exactly one record for each of parts 1\.\.3, got 1, 2/.test(p)),
      "a part that never reported must be named — this is the leg that silently did not run",
    );
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751), rec(2, 751)]).some((p) => /exactly one record for each of parts 1\.\.3, got 1, 2, 2/.test(p)),
      "the same part twice (and another missing) must be refused even though the ran-sum adds up",
    );
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751), rec(3, 750)]).some((p) => /the parts ran 2252 of 2253/.test(p)),
      "a short ran-sum across the parts must be refused with both numbers",
    );
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751), rec(3, 752)]).some((p) => /the parts ran 2254 of 2253/.test(p)),
      "an overshoot is a test run twice and must be refused too",
    );
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751), rec(3, 751, { seen: 2240 })]).some((p) => /disagree about how many tests/.test(p)),
      "parts that saw different suites must be refused",
    );
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751), rec(3, 751, { perPart: 3 })]).some((p) => /different numbers of shards/.test(p)),
      "parts with different shards-per-part do not tile the suite and must be refused",
    );
    assert.ok(
      coverageProblems([rec(1, 751), rec(2, 751, { parts: 4 })]).some((p) => /disagree about how many parts/.test(p)),
      "records from different splits must be refused",
    );
  }

  // ── 12. The gate SCRIPT is what `checks` runs: its exit code is the verdict ──────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), "phx-unit-coverage-"));
    try {
      const run = (...extra: string[]) =>
        spawnSync(process.execPath, ["scripts/ci-unit-coverage.mjs", dir, ...extra], { encoding: "utf8" });
      writeFileSync(join(dir, "unit-coverage-1.json"), JSON.stringify({ part: 1, parts: 2, perPart: 2, seen: 10, ran: 5 }));
      const short = run();
      assert.equal(short.status, 1, `one of two parts is a failure, got ${short.status}: ${short.stderr}`);
      assert.match(short.stderr, /expected exactly one record for each of parts 1\.\.2/);
      writeFileSync(join(dir, "unit-coverage-2.json"), JSON.stringify({ part: 2, parts: 2, perPart: 2, seen: 10, ran: 5 }));
      const whole = run();
      assert.equal(whole.status, 0, `both parts covering 10 of 10 must pass: ${whole.stderr}`);
      assert.match(whole.stdout, /ran 10 of 10 tests/);
      writeFileSync(join(dir, "unit-coverage-2.json"), JSON.stringify({ part: 2, parts: 2, perPart: 2, seen: 10, ran: "5" }));
      assert.equal(run().status, 1, "a record whose counts are not integers must be refused, not coerced");
      assert.equal(run("--bogus").status, 2, "an unknown flag must be refused (exit 2), never ignored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 13. THE DEAL — which shard runs each test (tests/shard-deal.ts, 2026-10-23) ────────────────
  // Every shard process builds its own dealer, so the property that matters is that independent
  // dealers agree: each call is claimed by exactly one shard. Then that the deal balances TIME, which
  // is the reason it is not round-robin any more.
  {
    const slowName = "runUnknownFlagGatesTests";
    // A synthetic suite with the slowest test LAST — the worst case for a deal made in one pass.
    const suite = [...Array.from({ length: 2_500 }, (_, i) => `runSynthetic${i}Tests`), ...Object.keys(KNOWN_SLOW_TESTS_MS)];
    suite.splice(suite.indexOf(slowName), 1);
    suite.push(slowName, "runSynthetic7Tests" /* a function registered twice */, "");

    for (const total of [1, 2, 3, 4, 6]) {
      const dealers = Array.from({ length: total }, () => createShardDeal(total));
      const claims = new Array<number>(suite.length).fill(0);
      suite.forEach((name, call) => {
        const answers = dealers.map((deal) => deal(name));
        assert.equal(new Set(answers).size, 1, `independent dealers disagree on call ${call} (${name}) at ${total} shards`);
        assert.ok(answers[0] >= 0 && answers[0] < total, `call ${call} was dealt to shard ${answers[0]} of ${total}`);
        claims[call] += 1;
      });
      assert.ok(claims.every((n) => n === 1), `at ${total} shards some call was claimed by no shard or by two`);
    }

    // An empty table is exactly the old round-robin, so the change is only ever the table.
    const plain = createShardDeal(4, {});
    suite.forEach((name, call) => assert.equal(plain(name), call % 4, `with no table, call ${call} must go to shard ${call % 4}`));

    // The table's key order cannot move a test: the placement sorts it.
    const reversed = Object.fromEntries(Object.entries(KNOWN_SLOW_TESTS_MS).reverse());
    const a = createShardDeal(4);
    const b = createShardDeal(4, reversed);
    suite.forEach((name, call) => assert.equal(a(name), b(name), `the table's key order moved call ${call}`));

    // Balance: estimated load per shard within 5% of the mean at two parts × two shards — where
    // round-robin leaves the slow test's shard far behind the others. Checked twice: with a synthetic
    // 120 s test registered LAST (so the property does not hang on today's numbers), and with the real table.
    const balance = (table: Readonly<Record<string, number>>, calls: string[]) => {
      const estimate = (name: string) => table[name] ?? DEFAULT_TEST_MS;
      const loads = (dealt: (name: string, call: number) => number) => {
        const load = [0, 0, 0, 0];
        calls.forEach((name, call) => (load[dealt(name, call)] += estimate(name)));
        return load;
      };
      const deal = createShardDeal(4, table);
      const balanced = loads((name) => deal(name));
      const mean = balanced.reduce((s, x) => s + x, 0) / 4;
      return { balanced, mean, roundRobin: loads((_, call) => call % 4) };
    };
    const heavy = { ...KNOWN_SLOW_TESTS_MS, runSyntheticHeavyTests: 120_000 };
    for (const [label, table, calls] of [
      ["a synthetic 120 s test registered last", heavy, [...suite, "runSyntheticHeavyTests"]],
      ["the real table", KNOWN_SLOW_TESTS_MS, suite],
    ] as const) {
      const { balanced, mean, roundRobin } = balance(table, [...calls]);
      assert.ok(
        Math.max(...balanced) <= mean * 1.05,
        `with ${label}, the deal left a shard at ${Math.max(...balanced)} ms against a mean of ${mean.toFixed(0)} ms — a slow test is stacking onto a full share again`,
      );
      if (table === heavy) {
        assert.ok(Math.max(...roundRobin) > mean * 1.5, "the synthetic suite must be one round-robin cannot balance, or the check above proves nothing");
      }
    }
  }

  // ── 14. The runner USES the deal, and every table entry is a test the runner registers ─────────
  {
    const runner = readFileSync(resolve("tests/run-tests.ts"), "utf8");
    assert.match(runner, /const dealShard = createShardDeal\(shardTotal\);/, "run-tests.ts must build its dealer from the global shard total");
    assert.match(runner, /const mine = dealShard\(execute\.name\) === shardIndex - 1;/, "runTest must ask the dealer which shard runs the call");
    assert.match(runner, /seenCount \+= 1;/, "every call must still count toward `seen`, mine or not — it is the coverage proof");
    assert.doesNotMatch(runner, /seenCount\+\+ % shardTotal/, "the round-robin deal is back beside the balanced one");
    const registered = runner.slice(runner.indexOf("async function runTest("));
    for (const name of Object.keys(KNOWN_SLOW_TESTS_MS)) {
      assert.match(
        registered,
        new RegExp(`\\b${name}\\b`),
        `${name} is in KNOWN_SLOW_TESTS_MS but run-tests.ts no longer registers it: its estimate weighs down a shard for a test that is not there`,
      );
    }
  }

  // ── 15. A shard that HANGS is stopped and named, never waited out (31 Oct 2026) ─────────────────
  // Two pull requests each held a unit job for its full 20-minute timeout because one test waited for
  // ever, and the log named nothing. The watch is the parent's: the hung child cannot be trusted to time
  // itself out, because its own timers or fetch may be what an earlier test broke.
  {
    assert.equal(hangLimitMs(undefined), 180_000, "the default limit is 180 s — fifteen times the slowest test, so only a stuck one reaches it");
    assert.equal(hangLimitMs(""), 180_000);
    assert.equal(hangLimitMs("2.5"), 2_500);
    for (const bad of ["0", "-1", "soon"]) {
      assert.throws(() => hangLimitMs(bad), /PHX_TEST_HANG_SECONDS must be a positive number/, `a limit of ${bad} must be refused, not read as "never"`);
    }

    const watch = createHangWatch(1_000, 0);
    assert.equal(watch.check(999), null, "a shard still importing inside the limit is not stuck");
    assert.deepEqual(watch.check(1_000), { name: null, seconds: 1, running: false }, "a shard that never starts a test is stuck before its first");
    watch.observe("PHX_TEST_START 7 the slow one", 1_000);
    assert.equal(watch.check(1_999), null, "a test inside its limit is not stuck");
    watch.observe("PHX_TEST_END 6", 1_500);
    assert.deepEqual(
      watch.check(2_000),
      { name: "the slow one", seconds: 1, running: true },
      "a test past its limit is named — and an END for a different id must not have cleared it",
    );
    watch.observe("PHX_TEST_END 7", 2_000);
    assert.equal(watch.check(2_999), null, "a finished test clears the watch");
    assert.deepEqual(
      watch.check(3_000),
      { name: "the slow one", seconds: 1, running: false },
      "a shard that stops moving after a test names the last one that finished",
    );

    const stopped = { index: 2, code: 1, signal: "SIGKILL", out: "PASS something\n", hung: { name: "the slow one", seconds: 181, running: true } };
    const problems = collectProblems([shard(1, 2, 2253, 1127), stopped], 2);
    assert.equal(problems.length, 1, `a hung shard is ONE problem, named once — got ${JSON.stringify(problems)}`);
    assert.match(problems[0], /^shard 2\/2 was stopped: "the slow one" was still running after 181s/, "the hang is reported by the test's name, not as a bare kill");
    assert.doesNotMatch(problems[0], /killed by SIGKILL/, "the kill is the watch's own consequence, never the headline");
    assert.ok(
      isTestMarker("PHX_TEST_START 1 x") && isTestMarker("PHX_TEST_END 1") && !isTestMarker("PASS x (1ms)"),
      "only the two markers are the watch's",
    );
  }

  // ── 16. …proven on real children: one stuck inside a test, one that never starts one, one that passes ─
  // Each fixture also ends ITSELF after 20 s, so a broken watch fails the deadline below instead of
  // leaving a process behind — and runs from the OS temp folder, not its own, because Windows will not
  // remove a folder a live process is standing in, and that error would hide the deadline message.
  {
    const dir = mkdtempSync(join(tmpdir(), "phx-shard-hang-"));
    try {
      const fixture = (file: string, body: string) => {
        writeFileSync(join(dir, file), `setTimeout(() => process.exit(0), 20_000);\n${body}\n`);
        return join(dir, file);
      };
      const stuck = fixture("stuck.mjs", 'console.log("PHX_TEST_START 3 a test whose request never arrives"); console.log("still waiting");');
      const quiet = fixture("quiet.mjs", 'console.log("importing");');
      const healthy = fixture(
        "healthy.mjs",
        'console.log("PHX_TEST_START 1 a quick test"); console.log("PASS a quick test (1ms)"); console.log("PHX_TEST_END 1"); ' +
          'console.log("a line a reader needs"); process.exit(0);',
      );
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
      const run = (file: string, index: number) => {
        const sink = { stdout: "", stderr: "" };
        return runShard({
          args: [file],
          cwd: tmpdir(),
          env,
          index,
          total: 3,
          hangMs: 1_500,
          pollMs: 100,
          stdout: { write: (text: string) => (sink.stdout += text) },
          stderr: { write: (text: string) => (sink.stderr += text) },
        }).then((value) => ({ ...value, sink }));
      };
      const startedAt = performance.now();
      const all = Promise.all([run(stuck, 1), run(quiet, 2), run(healthy, 3)]);
      const outcome = await Promise.race([all, sleep(10_000, "deadline", { ref: false })]);
      assert.notEqual(
        outcome,
        "deadline",
        "runShard did not stop a hung shard within 10 s at a 1.5 s limit — the watch is not watching, so a stuck test holds the CI job to its timeout again",
      );
      const [hungResult, quietResult, healthyResult] = await all;
      const seconds = (performance.now() - startedAt) / 1000;
      assert.ok(seconds < 10, `the hung shards took ${seconds.toFixed(1)} s to be stopped`);

      assert.equal(hungResult.hung?.name, "a test whose request never arrives", "the shard stuck inside a test must be stopped and that test named");
      assert.equal(hungResult.hung?.running, true);
      assert.match(hungResult.sink.stderr, /HUNG "a test whose request never arrives" — still running after \d+s/, "the stop is announced the moment it happens");
      assert.match(hungResult.sink.stdout, /still waiting/, "the shard's own lines still reach the reader");
      assert.doesNotMatch(hungResult.sink.stdout, /PHX_TEST_START/, "the watch's markers are never displayed");

      assert.equal(quietResult.hung?.running, false, "a shard that never starts a test is stopped too");
      assert.equal(quietResult.hung?.name, null);
      assert.match(collectProblems([quietResult], 3, { first: 2, count: 1 })[0], /went \d+s without starting its first test or exiting/);

      assert.equal(healthyResult.hung, null, "a shard that finishes inside the limit is never stopped");
      assert.equal(healthyResult.code, 0);
      assert.equal(healthyResult.sink.stdout, "[shard 3/3] a line a reader needs\n", "PASS lines and markers are hidden, everything else is shown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 17. The suite brackets every test with the markers, and the runner runs each shard under the watch ─
  {
    const runner = readFileSync(resolve("tests/run-tests.ts"), "utf8");
    const declaredAt = runner.indexOf("async function runTest(");
    const body = runner.slice(declaredAt, runner.indexOf("\n}\n", declaredAt));
    assert.match(body, /writeWatchMarker\?\.\(`PHX_TEST_START \$\{watchId\} /, "runTest must announce a test before it runs");
    assert.match(body, /\} finally \{\n\s+writeWatchMarker\?\.\(`PHX_TEST_END \$\{watchId\}\\n`\);/, "runTest must announce the end in a finally, so a FAILED test ends too");
    assert.match(
      runner,
      /const writeWatchMarker = shardSpec \? process\.stdout\.write\.bind\(process\.stdout\) : null;/,
      "the markers are written through the real stdout taken before any test runs, and only in a sharded run",
    );
    const sharded = readFileSync(resolve("scripts/run-tests-sharded.mjs"), "utf8");
    assert.match(sharded, /const hangMs = hangLimitMs\(process\.env\.PHX_TEST_HANG_SECONDS\);/, "the runner must read its limit");
    assert.match(sharded, /runShard\(\{ args, cwd: ROOT, env: process\.env, index: first \+ i, total, hangMs \}\)/, "every shard must run under the watch");
  }
}
