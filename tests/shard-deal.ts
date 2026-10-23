/**
 * Which shard runs each `runTest` call — the pure half of the deal in `tests/run-tests.ts`, kept
 * here so `tests/run-tests-sharded.test.ts` can pin it without running the suite.
 *
 * WHY NOT PLAIN ROUND-ROBIN ANY MORE (2026-10-23). Round-robin balances the COUNT of tests per
 * shard, not their time. One test — every script that parses arguments refuses an unknown one —
 * took ~115 s on its own (CI median, 20 runs), a quarter of the whole suite's ~484 shard-seconds, so
 * whichever shard drew it finished ~80 s after the others and its job set the PR's wait. It was halved
 * the same day (one spawn per script, not two), and it is still the slowest test by far. With the
 * suite in two jobs instead of three, that gap is the difference between a faster and a slower PR.
 *
 * THE DEAL, deterministic in every process:
 *   1. The known slow tests ({@link KNOWN_SLOW_TESTS_MS}) are placed FIRST, heaviest first, each on
 *      the least-loaded shard — so the slowest test owns a shard and the next-heaviest go elsewhere.
 *   2. Every other call, in registration order, goes to the shard with the least estimated load so
 *      far, at {@link DEFAULT_TEST_MS} each. The shard holding the slowest test therefore takes fewer
 *      of the rest until the others catch up.
 *   3. A tie goes to the LOWEST index — so with an empty table this is exactly the old round-robin.
 *
 * 🔴 EVERY PROCESS MUST COMPUTE THE SAME ANSWER, OR A TEST RUNS TWICE OR NEVER. The deal reads only
 * the shard total, the table and the order and function names of the `runTest` calls — all identical
 * in every shard and every part, because every shard imports the same file. It never reads a clock,
 * a measured duration or the environment. `seen`/`ran` in run-tests.ts still prove the outcome: a
 * deal that dropped or doubled a test fails the coverage gate in `checks`, by name.
 *
 * The estimates only steer placement. A wrong one costs balance, never coverage: a renamed test
 * falls back to the default weight, and an entry that matches nothing leaves its shard a little
 * light. Refresh them from the unit jobs' "Slowest:" lines when the split drifts.
 */

/**
 * Estimated milliseconds of the slow tests, keyed by the function `runTest` is handed. Median of the
 * per-shard "Slowest:" lists of 20 green CI runs, 21–23 Oct 2026, with two shards sharing a
 * 2-vCPU runner. Only tests well above the default are worth listing.
 */
export const KNOWN_SLOW_TESTS_MS: Readonly<Record<string, number>> = {
  // 114.8 s measured with two spawns per script; one spawn since 2026-10-23 took 46% of the time on a
  // 10-script sample, so this is an ESTIMATE until the next "Slowest:" read replaces it.
  runUnknownFlagGatesTests: 53_000,
  runLocalTypecheckGuardTests: 11_200,
  runUnitsAreUnitsNoDiscountFactorTests: 10_600,
  runClosingRepRankingTests: 9_300,
  runMergeCooldownGuardTests: 8_100,
  runSelectCensusTests: 7_700,
  runNeutralWordingTests: 7_400,
  runPythonReplGuardTests: 6_700,
  runPhoenixCrmDuplicatePhotosTests: 6_500,
  runAccessRegistryCoverageTests: 5_800,
  runPhoenixCrmDictationCorpusTests: 5_600,
  runApiGrantedButUncalledTests: 5_300,
  runRollupPrsTests: 5_000,
  runScheduledNotificationKeyRatchetTests: 5_000,
  runBashGrepGuardTests: 4_900,
  runFormDesignGuardTests: 4_800,
  runPushTypecheckGuardTests: 4_700,
  runClosingWorkbookLockTests: 4_300,
  runCrmMasterExportWorkbookTests: 4_300,
  runHookDispatchTests: 4_300,
  runWorkflowDispatchGuardTests: 4_200,
  runWorktreeExitGuardPreRemovalTests: 4_000,
  runEmailProviderFailoverTests: 4_000,
};

/**
 * The estimate for any test not in the table: the rest of the suite's shard-seconds over its count —
 * (484 s − 248 s listed above) over ~2,520 tests, measured from the same 20 runs.
 */
export const DEFAULT_TEST_MS = 95;

/** Index of the least-loaded shard, the lowest index on a tie. */
function leastLoaded(load: number[]): number {
  let best = 0;
  for (let index = 1; index < load.length; index += 1) if (load[index] < load[best]) best = index;
  return best;
}

/**
 * A dealer for `total` shards: call it once per `runTest`, in order, with the function's name, and
 * it returns the 0-based shard that runs that call.
 */
export function createShardDeal(
  total: number,
  slow: Readonly<Record<string, number>> = KNOWN_SLOW_TESTS_MS,
  defaultMs: number = DEFAULT_TEST_MS,
): (name: string) => number {
  const load = new Array<number>(total).fill(0);
  const reserved = new Map<string, number>();
  // Heaviest first; equal weights in name order, so the placement never depends on key order.
  const entries = Object.entries(slow).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, ms] of entries) {
    const shard = leastLoaded(load);
    reserved.set(name, shard);
    load[shard] += ms;
  }
  return (name: string) => {
    // A reserved test was counted when it was placed; a second call to the same function goes to the
    // same shard and is not counted again — it is still run exactly once by exactly one shard.
    const shard = reserved.get(name);
    if (shard !== undefined) return shard;
    const next = leastLoaded(load);
    load[next] += defaultMs;
    return next;
  };
}
