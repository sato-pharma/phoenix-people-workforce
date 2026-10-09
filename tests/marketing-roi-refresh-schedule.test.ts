import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The Marketing ROI fact rebuild runs on a clock, and the schedule lives in a migration.
 *
 * Owner's decision, 2026-10-09, the same evening the Sales & Marketing Intelligence dashboard was
 * switched onto the fact tables (`NEXT_PUBLIC_SMI_USE_FACT_TABLES=true` on the production service).
 * Until then the dashboard computed live and staleness was impossible. It now serves
 * `marketing_roi_*_facts`, and `phx_refresh_marketing_roi_facts` was called by nothing on a clock —
 * only a Source-of-Sales import, the normalizer, direct-order tracking and the manual
 * `/api/marketing/roi-refresh` route — so between imports the dashboard's numbers would simply be
 * old, with the payload's own freshness still reading `fresh` (it compares against the last
 * validated batch, never against the clock).
 *
 * 🔴 A SCHEDULE MADE BY HAND IS NOT A SCHEDULE THE SYSTEM HAS. The recovery snapshot proved it:
 * its job existed only in `cron.job`, so a restored or recreated database came back with the store
 * deployed and never running (20261008140000_schedule_recovery_snapshot_cron closed that). This
 * file pins the same three safety properties for the ROI job — scheduled BY NAME, guarded on
 * pg_extension, refusing a second caller of that name — plus the two that are specific to it: the
 * real entry point, and a minute that does not collide with the other hourly job.
 */

/** The migration that schedules it, found by CONTENT — a rename or a later supersede still resolves. */
function scheduleMigration(): { file: string; sql: string } {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  let found: { file: string; sql: string } | null = null;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(name, dir), "utf8");
    if (/cron\.schedule\(\s*'phoenix-marketing-roi-refresh'/.test(sql)) found = { file: name, sql };
  }
  assert.ok(
    found,
    "no migration schedules 'phoenix-marketing-roi-refresh' — the ROI fact tables would then be as fresh as the last Source-of-Sales import, and a restored database would never refresh them at all",
  );
  return found!;
}

export function runMarketingRoiRefreshScheduleTests() {
  const { file, sql } = scheduleMigration();

  assert.match(
    sql,
    /cron\.schedule\(\s*'phoenix-marketing-roi-refresh',\s*'20 \* \* \* \*',\s*'select public\.phx_refresh_marketing_roi_facts\(\);'\s*\)/,
    `${file}: it must schedule BY NAME, hourly at :20, calling the real entry point — cron.schedule updates the job of that name rather than adding a second hourly caller, which is what makes re-applying it safe on a live production`,
  );

  // :05 is phoenix-recovery-snapshot and 01:40 is phoenix-data-retention (read live from cron.job,
  // 2026-10-09). Two hourly jobs starting in the same minute would contend for the same connections
  // for no reason.
  assert.doesNotMatch(
    sql,
    /cron\.schedule\(\s*'phoenix-marketing-roi-refresh',\s*'5 \* \* \* \*'/,
    `${file}: :05 belongs to phoenix-recovery-snapshot — the ROI job must not start in the same minute`,
  );

  assert.match(
    sql,
    /pg_extension\s+where\s+extname\s*=\s*'pg_cron'/,
    `${file}: it must be guarded on pg_extension — an unguarded cron.schedule fails the migrate on any database without the extension, and a failed staging migrate withholds the production deploy`,
  );
  assert.ok(
    /raise\s+warning/i.test(sql) && !/create\s+extension/i.test(sql),
    `${file}: where pg_cron is absent it must WARN and move on, never install the extension itself`,
  );
  assert.match(
    sql,
    /raise exception 'found % jobs named phoenix-marketing-roi-refresh/,
    `${file}: two jobs of that name are two hourly callers — the migration must refuse rather than add a third`,
  );
  // A cron.schedule that reports success and leaves no row has happened; the migration re-reads
  // cron.job so a schedule that did not take fails the apply instead of passing quietly.
  assert.match(
    sql,
    /from\s+cron\.job\s*\n?\s*where jobname = 'phoenix-marketing-roi-refresh'/,
    `${file}: it must re-read cron.job after scheduling, or a no-op apply reads as a success`,
  );

  // ── The function it schedules must still be the one that tolerates an overlapping run ─────────
  // The hourly tick can land while an import-triggered rebuild is running. That is safe only
  // because the function itself takes a transaction-level advisory lock and returns 'skipped';
  // nothing in the schedule enforces it, so the guarantee is pinned where it actually lives.
  const dir = new URL("../supabase/migrations/", import.meta.url);
  let refreshBody: string | null = null;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(new URL(name, dir), "utf8");
    if (/create\s+or\s+replace\s+function\s+public\.phx_refresh_marketing_roi_facts\s*\(/i.test(text)) refreshBody = text;
  }
  assert.ok(refreshBody, "no migration defines phx_refresh_marketing_roi_facts — the schedule would call nothing");
  assert.match(
    refreshBody!,
    /pg_try_advisory_xact_lock\(v_lock_key\)/,
    "the refresh must hold an advisory lock: without it an hourly tick can run concurrently with an import's rebuild, and both write the same fact rows",
  );
  assert.match(
    refreshBody!,
    /'status',\s*'skipped'/,
    "a run that cannot take the lock must report 'skipped' rather than raising — a raised error inside pg_cron is only visible in cron.job_run_details",
  );
}
