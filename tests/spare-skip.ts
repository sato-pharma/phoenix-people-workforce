/**
 * 🔴 THE SPARE LAPTOP'S ONE SKIP — `PHX_SPARE_SKIP_CV_WORKER_TEST=1` leaves out exactly ONE test, the CV worker
 * test (`runCvTextIsolationTests`), and ONLY on the spare laptop (owner, 2026-11-07: "skip the CV worker test on
 * the spare only").
 *
 * Why: on the spare (Windows, 8 GB) node dies by access violation (0xC0000005) inside that test in six of seven
 * suite runs, on Node 24.22.1 and on a pinned 24.15.0 alike; it passes when run alone, a retry crashed again, and
 * a memory sampler caught the crash with 824 MB physical and 9.6 GB commit free, so it is not RAM. CI (Linux)
 * never sees it. The crash takes the whole shard with it, so no spare run ever reached its summary.
 *
 * What it may NOT do:
 *  - skip anything else — the list is one name, held here, never read from the environment;
 *  - run on CI — with `CI` or `GITHUB_ACTIONS` set the runner refuses to start (exit 2), so the required checks
 *    can never be turned green by a skip;
 *  - hide itself — a skipped test is NOT counted as ran (`PHX_SHARD_RESULT` stays honest and byte-identical in
 *    format) and each shard that skipped prints its own `PHX_SHARD_SKIPPED` line, which
 *    `~/.claude/scripts/spare-test.ps1` adds back to say "ran X + 1 skipped on purpose of Y".
 */
export const SPARE_SKIP_SWITCH = "PHX_SPARE_SKIP_CV_WORKER_TEST";

/** The `execute` function names the switch leaves out. One name; widening it needs the owner's word. */
export const SPARE_SKIPPED_TESTS: ReadonlySet<string> = new Set(["runCvTextIsolationTests"]);

type Env = Record<string, string | undefined>;

export function spareSkipArmed(env: Env): boolean {
  return env[SPARE_SKIP_SWITCH] === "1";
}

/** A reason to refuse the whole run, or null. The switch armed on CI is the only refusal. */
export function spareSkipRefusal(env: Env): string | null {
  if (!spareSkipArmed(env)) return null;
  const ci = ["CI", "GITHUB_ACTIONS"].filter((name) => (env[name] ?? "") !== "" && env[name] !== "false");
  if (ci.length === 0) return null;
  return (
    `${SPARE_SKIP_SWITCH}=1 is the spare laptop's switch and is refused on CI (${ci.join(", ")} set): ` +
    `the required checks must run every test`
  );
}

/** Whether this test is left out of this run. Never true unless armed, and never for a name outside the list. */
export function spareSkips(env: Env, executeName: string): boolean {
  return spareSkipArmed(env) && SPARE_SKIPPED_TESTS.has(executeName);
}
