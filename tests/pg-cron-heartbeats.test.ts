import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

import { parseCheckMeta, parseDesiredChecks } from "../scripts/healthchecks-sync.mjs";
import { findJobSchedule } from "../src/lib/observability/job-schedule.ts";

/**
 * Every pg_cron job reports to the job heartbeat register, and a new one cannot slip in unwatched.
 *
 * Read on production 2026-10-23: seven pg_cron jobs, none declared in `JOB_SCHEDULES`, none writing
 * a heartbeat — any of them could stop and nothing would say so. The departed-agent cache's job was
 * wired first (`tests/crm-agent-crm-ids-reconcile-heartbeat.test.ts`); the owner then chose "Watch
 * all six", and `20261023223000_pg_cron_jobs_report_heartbeats.sql` does the rest.
 *
 * What is pinned, each by the failure it prevents:
 *   1. Each wrapper calls its UNCHANGED function, then records the outcome — never before it.
 *   2. No wrapper catches: a caught failure reads `succeeded` in cron.job_run_details.
 *   3. The recovery snapshot records 'fail' when take_snapshots() reports an error — that function
 *      catches per table, so recording success over it would be a false success.
 *   4. The re-point uses cron.alter_job and never cron.schedule, so it can never CREATE a job — staging
 *      carries no data retention by the owner's decision — and it refuses an unexpected command.
 *   5. Each slug is declared on the job's real cadence and marked in-house only in the doc.
 *   6. Every cron.schedule in every migration names a watched job, and no later migration points one
 *      of these back at its bare function.
 *
 * A job born later with its wrapper already in place (the nightly statistics sweep, 2026-10-25) names its
 * own `migration` and the UTC `scheduledAt` it is created with; every other check applies to it unchanged.
 */

const MIGRATION_DIR = "supabase/migrations";
const MIGRATION = "20261023223000_pg_cron_jobs_report_heartbeats.sql";
const DOC = "docs/observability.md";

type Job = {
  job: string;
  slug: string;
  bare: string;
  wrapper: string;
  schedule: string;
  graceSeconds: number;
  tags: string[];
  /** The migration defining the wrapper, when it is not MIGRATION. */
  migration?: string;
  /** Set when that migration CREATES the job with cron.schedule, already on its wrapper: the UTC schedule. */
  scheduledAt?: string;
};

const JOBS: Job[] = [
  {
    job: "crm-person-by-hr-key-reconcile",
    slug: "phoenix-crm-person-by-hr-key-reconcile",
    bare: "public.crm_person_by_hr_key_reconcile()",
    wrapper: "public.crm_person_by_hr_key_reconcile_run()",
    schedule: "*/15 * * * *",
    graceSeconds: 3600,
    tags: ["crm", "in-house-only"],
  },
  {
    job: "phoenix-crm-contact-truth-reconcile",
    slug: "phoenix-crm-contact-truth-reconcile",
    bare: "public.phoenix_crm_contact_truth_reconcile()",
    wrapper: "public.phoenix_crm_contact_truth_reconcile_run()",
    schedule: "*/15 * * * *",
    graceSeconds: 3600,
    tags: ["crm", "in-house-only"],
  },
  {
    job: "phoenix-crm-rep-entry-days-reconcile",
    slug: "phoenix-crm-rep-entry-days-reconcile",
    bare: "public.phoenix_crm_rep_entry_days_reconcile()",
    wrapper: "public.phoenix_crm_rep_entry_days_reconcile_run()",
    schedule: "*/5 * * * *",
    graceSeconds: 1800,
    tags: ["crm", "in-house-only"],
  },
  {
    // 01:40 UTC: 03:40 Cairo in winter, 04:40 in summer. Declared at the EARLIER reading.
    job: "phoenix-data-retention",
    slug: "phoenix-data-retention",
    bare: "public.phx_prune_retention()",
    wrapper: "public.phx_prune_retention_run()",
    schedule: "40 3 * * *",
    graceSeconds: 7200,
    tags: ["platform", "in-house-only"],
  },
  {
    job: "phoenix-marketing-roi-refresh",
    slug: "phoenix-marketing-roi-refresh",
    bare: "public.phx_refresh_marketing_roi_facts()",
    wrapper: "public.phx_refresh_marketing_roi_facts_run()",
    schedule: "20 * * * *",
    graceSeconds: 3600,
    tags: ["marketing", "in-house-only"],
  },
  {
    job: "phoenix-recovery-snapshot",
    slug: "phoenix-recovery-snapshot",
    bare: "recovery.take_snapshots()",
    wrapper: "public.phx_recovery_take_snapshots_run()",
    schedule: "5 * * * *",
    graceSeconds: 3600,
    tags: ["platform", "in-house-only"],
  },
  {
    // 02:20 UTC: 04:20 Cairo in winter, 05:20 in summer. Declared at the EARLIER reading.
    job: "phoenix-analyze-tables-without-statistics",
    slug: "phoenix-analyze-tables-without-statistics",
    bare: "public.phx_analyze_tables_without_statistics()",
    wrapper: "public.phx_analyze_tables_without_statistics_run()",
    schedule: "20 4 * * *",
    graceSeconds: 7200,
    tags: ["platform", "in-house-only"],
    migration: "20261025230153_analyze_tables_with_no_statistics_nightly.sql",
    scheduledAt: "20 2 * * *",
  },
];

/** The departed-agent cache's job, wired by 20261023220000 and pinned by its own test. */
const AGENT_JOB = "crm-agent-crm-ids-reconcile";

function read(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** One function's body — between its header and its closing `$function$;`. */
function functionBody(sql: string, qualifiedName: string, file: string = MIGRATION): string {
  const start = sql.indexOf(`create or replace function ${qualifiedName}`);
  assert.notEqual(start, -1, `${qualifiedName} is defined in ${file}`);
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${qualifiedName}'s body ends`);
  return sql.slice(start, end);
}

function migrationNames(): string[] {
  return readdirSync(new URL(`../${MIGRATION_DIR}/`, import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export async function runPgCronHeartbeatsTests(): Promise<void> {
  const sql = stripSqlComments(read(`${MIGRATION_DIR}/${MIGRATION}`));
  const flatSql = flat(sql);
  const doc = read(DOC);
  const docChecks = new Map(
    (parseDesiredChecks(doc) as Array<{ slug: string; externalSync: boolean }>).map((check) => [check.slug, check] as const),
  );
  const docMeta = parseCheckMeta(doc) as Map<string, { tags: string[] }>;

  for (const job of JOBS) {
    const file = job.migration ?? MIGRATION;
    const jobSql = file === MIGRATION ? sql : stripSqlComments(read(`${MIGRATION_DIR}/${file}`));
    const jobFlatSql = flat(jobSql);

    // ── 1 and 2. The unchanged function first, then the record, and nothing caught ─────────────
    const body = flat(functionBody(jobSql, job.wrapper.replace(/\(\)$/, "("), file));
    const workAt = body.indexOf(`:= ${job.bare};`);
    const recordAt = body.indexOf(`perform public.phx_record_job_heartbeat( '${job.slug}', 'success'`) === -1
      ? body.indexOf(`perform public.phx_record_job_heartbeat('${job.slug}', 'success'`)
      : body.indexOf(`perform public.phx_record_job_heartbeat( '${job.slug}', 'success'`);
    assert.notEqual(workAt, -1, `${job.wrapper} runs the unchanged ${job.bare}`);
    assert.notEqual(recordAt, -1, `${job.wrapper} records success under ${job.slug}`);
    assert.ok(
      workAt < recordAt,
      `${job.wrapper} records success AFTER ${job.bare} returns — a success written first reports work that has not happened`,
    );
    assert.ok(
      !/\bexception\b/.test(body),
      `${job.wrapper} must NOT catch: pg_cron runs it in one transaction, so a caught failure reads \`succeeded\` in cron.job_run_details`,
    );

    // ── 4. Re-pointed by alter_job, from the known bare command only — or born on its wrapper ────
    if (job.scheduledAt) {
      assert.ok(
        jobFlatSql.includes(`cron.schedule( '${job.job}', '${job.scheduledAt}', 'select ${job.wrapper};' )`),
        `${file} schedules ${job.job} at ${job.scheduledAt} UTC on 'select ${job.wrapper};'`,
      );
    } else {
      assert.ok(
        jobFlatSql.includes(`('${job.job}', 'select ${job.bare};', 'select ${job.wrapper};')`),
        `${job.job} is re-pointed from exactly 'select ${job.bare};' to 'select ${job.wrapper};'`,
      );
    }

    // ── Reachable by the service role only ──────────────────────────────────────────────────────
    assert.ok(
      jobSql.includes(`revoke execute on function ${job.wrapper} from public, anon, authenticated;`) &&
        jobSql.includes(`grant execute on function ${job.wrapper} to service_role;`),
      `${job.wrapper} is revoked from the browser roles and granted to service_role`,
    );

    // ── 5. Declared on the real cadence, in-house only ──────────────────────────────────────────
    const declared = findJobSchedule(job.slug);
    assert.ok(declared, `${job.slug} is declared in JOB_SCHEDULES — an undeclared slug is written and judged by nobody`);
    assert.equal(declared.kind, "cron");
    assert.equal(declared.schedule, job.schedule, `${job.slug} is declared on its pg_cron cadence, read as Cairo`);
    assert.equal(declared.graceSeconds, job.graceSeconds, `${job.slug}'s grace`);
    assert.equal(declared.watchingSince, undefined, `${job.slug} is a new declaration and carries no watchingSince`);
    assert.equal(
      docChecks.get(job.slug)?.externalSync,
      false,
      `${job.slug}'s ${DOC} row is in-house only — nothing pings Healthchecks for it, and a sync asking would fail at the ceiling for ever`,
    );
    assert.deepEqual([...(docMeta.get(job.slug)?.tags ?? [])].sort(), [...job.tags].sort(), `${job.slug}'s tags`);
  }

  // ── 3. The recovery snapshot reports the failure take_snapshots() caught ──────────────────────
  {
    const body = flat(functionBody(sql, "public.phx_recovery_take_snapshots_run("));
    assert.ok(
      body.includes(
        "if v_out ->> 'error' is not null then perform public.phx_record_job_heartbeat( 'phoenix-recovery-snapshot', 'fail',",
      ),
      "take_snapshots() catches per table and returns the message in `error`; the wrapper must record 'fail' then, or a run that lost a table reads as a success",
    );
  }

  // ── 4. alter_job only: this migration can never create a job ────────────────────────────────
  assert.ok(!/\bcron\.schedule\s*\(/.test(sql), `${MIGRATION} must not call cron.schedule — it would CREATE a missing job (staging has no data retention by the owner's decision)`);
  assert.ok(
    flatSql.includes("perform cron.alter_job(job_id := v_jobid, command := v_job.wrapper_command);"),
    "the re-point changes only the command of a job that exists",
  );
  assert.ok(
    flatSql.includes("if v_named = 0 then raise notice") && flatSql.includes("continue;"),
    "a job absent here is left absent",
  );
  assert.ok(
    flatSql.includes("if v_command not in (v_job.bare_command, v_job.wrapper_command) then raise exception"),
    "a job running an unexpected command is refused, never overwritten",
  );

  // ── 6. Every scheduled job is watched, and none is pointed back ───────────────────────────────
  const watched = new Set([AGENT_JOB, ...JOBS.map((job) => job.job)]);
  for (const name of migrationNames()) {
    const body = flat(stripSqlComments(read(`${MIGRATION_DIR}/${name}`)));
    for (const match of body.matchAll(/cron\.schedule\( ?'([^']+)'/g)) {
      assert.ok(
        watched.has(match[1]),
        `${name} schedules pg_cron job '${match[1]}', which nothing watches — wrap it in a _run() that calls phx_record_job_heartbeat, declare its slug in JOB_SCHEDULES and ${DOC}, and add it here`,
      );
    }
    if (name <= MIGRATION) continue;
    for (const job of JOBS) {
      const at = body.indexOf(`cron.schedule( '${job.job}'`) === -1
        ? body.indexOf(`cron.schedule('${job.job}'`)
        : body.indexOf(`cron.schedule( '${job.job}'`);
      if (at === -1) continue;
      assert.ok(
        body.slice(at, at + 240).includes(`select ${job.wrapper};`),
        `${name} re-schedules ${job.job} without its reporting wrapper — it would stop reporting while still declared`,
      );
    }
  }
}
