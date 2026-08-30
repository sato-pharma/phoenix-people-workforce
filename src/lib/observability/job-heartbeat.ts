import { isProductionRuntime } from "@/config/system-settings";
import {
  assessJobHeartbeats,
  type JobHeartbeatRow,
  type JobHeartbeatVerdict,
} from "@/lib/observability/job-heartbeat-assess";
import { JOB_SCHEDULES, declaredJobSlugs } from "@/lib/observability/job-schedule";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Database side of the in-house dead-man's switch. The verdict logic is in
 * `job-heartbeat-assess.ts` and imports nothing from here, so it stays unit-testable.
 */

const TABLE = "job_heartbeats";
const MAX_DETAIL_CHARS = 2_000;

/**
 * WHY THIS IS GATED TWICE, and why removing either half would be actively dangerous.
 *
 * A false SUCCESS in this register is worse than no register at all: it makes a job that has
 * genuinely stopped look alive, which is the exact failure the whole layer exists to prevent,
 * manufactured by the tool meant to detect it. Two different accidents can produce one.
 *
 *  1. `isProductionRuntime()` — `.env.local` on the owner's laptop points at the PRODUCTION
 *     Supabase project (AGENTS.md §3), so `pnpm run dev` mutates production data. Opening a cron
 *     route locally is a normal thing to do while developing one, and without this it would stamp
 *     a fresh success into the production register.
 *
 *  2. The suite flags — and this half is not theoretical. `tests/dead-mans-switch.test.ts`
 *     deliberately sets `APP_ENV=production` to exercise the ping, so gate 1 does NOT hold during
 *     the suite; and `pnpm run test` runs with `--env-file-if-exists=.env.local`, i.e. holding
 *     live production credentials. Without this, running the test suite would write half a dozen
 *     fabricated successes straight into production for real job slugs.
 *
 *     TWO flags, and `PHOENIX_TEST_SUITE` is the load-bearing one. `NODE_ENV` alone would leave
 *     this gate depending on other tests' restore discipline: `config-drift.test.ts` and
 *     `cron-auth-policy.test.ts` both reassign NODE_ENV mid-suite — the former to "production",
 *     alongside `APP_ENV=production` — and restore it in a `finally`. That restore is correct
 *     today, but a gate protecting production writes must not be one refactor away from opening.
 *     `PHOENIX_TEST_SUITE` is set once by `tests/run-tests.ts` and read by nothing else, so no
 *     save/restore dance can leave it wrong. Both are read lazily, per call, so module import
 *     order does not matter (the suite sets them after every import has already evaluated).
 */
function heartbeatsEnabled(): boolean {
  if (process.env.PHOENIX_TEST_SUITE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return isProductionRuntime();
}

/**
 * Record what one job just reported about itself. Best-effort by contract: NEVER throws, never
 * delays the job's own result. A register write that fails must not turn a working job into a
 * failing one — the same rule `pingDeadMansSwitch` follows for the external ping.
 */
export async function recordJobHeartbeat(
  slug: string,
  outcome: "success" | "fail",
  detail?: string,
): Promise<void> {
  if (!heartbeatsEnabled()) return;

  const nowIso = new Date().toISOString();
  try {
    // Only the timestamp for THIS outcome is written. Sending both columns every time would erase
    // the last success the moment a job failed once, and the gap between the two is the single
    // most useful thing the table records.
    const { error } = await getSupabaseAdmin()
      .from(TABLE)
      .upsert(
        {
          last_detail: detail ? detail.slice(0, MAX_DETAIL_CHARS) : null,
          last_outcome: outcome,
          slug,
          updated_at: nowIso,
          ...(outcome === "success" ? { last_success_at: nowIso } : { last_fail_at: nowIso }),
        },
        { onConflict: "slug" },
      );
    if (error) throw new Error(error.message);
  } catch (error) {
    // logWarning, not logError: a failed heartbeat write is not an application failure and must
    // never itself page anyone.
    logWarning("Job heartbeat write failed (non-fatal — the job's own result is unaffected)", {
      error,
      labels: { event: "job_heartbeat_write_failed", job: slug, outcome },
    });
  }
}

/**
 * Insert a row for every declared slug that does not have one yet, so a newly declared job is
 * KNOWN before it is judged. `first_seen_at` defaults to now(), which is the anchor
 * `assessJobHeartbeats` uses to avoid alarming on a job that has simply never had a chance to run.
 *
 * `ignoreDuplicates` matters: this runs on every sweep, and without it the upsert would rewrite
 * `first_seen_at`-adjacent columns on rows that already exist and are perfectly healthy.
 */
export async function bootstrapJobHeartbeatRows(): Promise<number> {
  const slugs = declaredJobSlugs();
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      slugs.map((slug) => ({ slug })),
      { ignoreDuplicates: true, onConflict: "slug" },
    );
  if (error) throw new Error(`Could not bootstrap the job heartbeat register: ${error.message}`);
  return slugs.length;
}

export async function readJobHeartbeats(): Promise<JobHeartbeatRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("slug, first_seen_at, last_outcome, last_success_at, last_fail_at, last_detail");
  if (error) throw new Error(`Could not read the job heartbeat register: ${error.message}`);
  return (data ?? []).map((row) => ({
    firstSeenAt: String(row.first_seen_at),
    lastDetail: row.last_detail === null ? null : String(row.last_detail),
    lastFailAt: row.last_fail_at === null ? null : String(row.last_fail_at),
    lastOutcome: row.last_outcome === "success" || row.last_outcome === "fail" ? row.last_outcome : null,
    lastSuccessAt: row.last_success_at === null ? null : String(row.last_success_at),
    slug: String(row.slug),
  }));
}

/**
 * One full sweep: make sure every declared job is known, read the register, and judge it.
 *
 * The row count is small and fixed (one per declared job), so this reads the whole table with no
 * filter and no pagination — well clear of the 1000-row PostgREST ceiling that silently truncates
 * unbounded selects elsewhere in this codebase.
 */
export async function sweepJobHeartbeats(now: Date = new Date()): Promise<JobHeartbeatVerdict> {
  await bootstrapJobHeartbeatRows();
  const rows = await readJobHeartbeats();
  return assessJobHeartbeats({ declarations: JOB_SCHEDULES, now, rows });
}
