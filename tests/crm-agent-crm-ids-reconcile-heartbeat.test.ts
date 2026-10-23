import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

import { parseCheckMeta, parseDesiredChecks } from "../scripts/healthchecks-sync.mjs";
import { findJobSchedule } from "../src/lib/observability/job-schedule.ts";

/**
 * The departed-agent CRM id cache can no longer freeze in silence.
 *
 * `crm_agent_crm_ids_cache` is kept current by ONE thing — the pg_cron job
 * `crm-agent-crm-ids-reconcile` — and its door deliberately never falls back to the live read. Until
 * 2026-10-23 nothing watched that job: no heartbeat row, no declaration, no alarm. Now the job runs
 * `crm_agent_crm_ids_reconcile_run()`, which records success in `public.job_heartbeats` after each
 * run, and the slug is declared so the 15-minute sweep judges it.
 *
 * Four things are pinned, each by the failure it prevents:
 *   1. The job runs the REPORTING wrapper — a re-schedule back to the bare reconcile unwatches it.
 *   2. Success is recorded AFTER the reconcile, never before — a false success is worse than none.
 *   3. The wrapper does NOT catch a failed run — a catch would leave `cron.job_run_details` reading
 *      `succeeded` for a run that failed, since the job's one transaction cannot keep a 'fail' row
 *      through a re-raise.
 *   4. The SQL slug and cadence are the declared ones, and the doc marks the row in-house only.
 */

const MIGRATION_DIR = "supabase/migrations";
const MIGRATION = "20261023220000_crm_agent_crm_ids_reconcile_heartbeat.sql";
const SLUG = "phoenix-crm-agent-crm-ids-reconcile";
const JOB = "crm-agent-crm-ids-reconcile";
const WRAPPER_COMMAND = "select public.crm_agent_crm_ids_reconcile_run();";
const DOC = "docs/observability.md";

function read(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

/** One function's body — between its header and its closing `$function$;`. */
function functionBody(sql: string, signature: string): string {
  const start = sql.indexOf(`create or replace function public.${signature}`);
  assert.notEqual(start, -1, `${signature} is defined in ${MIGRATION}`);
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${signature}'s body ends`);
  return sql.slice(start, end);
}

/** Whitespace collapsed, so a pin reads the SQL and not its indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export async function runCrmAgentCrmIdsReconcileHeartbeatTests(): Promise<void> {
  const sql = stripSqlComments(read(`${MIGRATION_DIR}/${MIGRATION}`));

  // ── 1. The job runs the reporting wrapper, and no later migration points it back ──────────────
  {
    const scheduled = flat(sql);
    assert.ok(
      scheduled.includes(`cron.schedule( '${JOB}', '*/15 * * * *', '${WRAPPER_COMMAND}' )`),
      `${JOB} is re-pointed at the reporting wrapper on its unchanged */15 cadence`,
    );
    assert.ok(
      scheduled.includes(`if v_command <> '${WRAPPER_COMMAND}' then raise exception`),
      "the migration refuses to commit unless the live job now runs the wrapper",
    );

    // The scheduler call that runs LAST wins. A later migration that re-schedules this job must keep
    // the wrapper, or the cache is unwatched again while the declaration says otherwise.
    const later = readdirSync(new URL(`../${MIGRATION_DIR}/`, import.meta.url))
      .filter((name) => name.endsWith(".sql") && name > MIGRATION)
      .sort();
    for (const name of later) {
      const body = flat(stripSqlComments(read(`${MIGRATION_DIR}/${name}`)));
      const at = body.indexOf(`cron.schedule( '${JOB}'`);
      if (at === -1) continue;
      assert.ok(
        body.slice(at, at + 200).includes(WRAPPER_COMMAND),
        `${name} re-schedules ${JOB} without the reporting wrapper — the cache would freeze unwatched again`,
      );
    }
  }

  // ── 2 and 3. Success after the work, and a failure left uncaught ──────────────────────────────
  {
    const wrapper = flat(functionBody(sql, "crm_agent_crm_ids_reconcile_run("));
    const workAt = wrapper.indexOf("v_diff := public.crm_agent_crm_ids_reconcile();");
    const successAt = wrapper.indexOf(`perform public.phx_record_job_heartbeat( '${SLUG}', 'success',`);
    assert.notEqual(workAt, -1, "the wrapper runs the UNCHANGED reconcile");
    assert.notEqual(successAt, -1, `the wrapper records success under ${SLUG}`);
    assert.ok(
      workAt < successAt,
      "success is recorded AFTER the reconcile returns — a success written first would report work that has not happened",
    );
    assert.ok(
      !/\bexception\b/.test(wrapper),
      "the wrapper must NOT catch a failed run: pg_cron runs it in one transaction, so a caught failure reads `succeeded` in cron.job_run_details",
    );
    assert.ok(
      !wrapper.includes("'fail'"),
      "the wrapper writes no 'fail' row — it could only do so by catching, which is the false success above",
    );
  }

  // ── The register write mirrors recordJobHeartbeat ─────────────────────────────────────────────
  {
    const helper = flat(functionBody(sql, "phx_record_job_heartbeat("));
    assert.ok(
      helper.includes(
        "last_success_at = case when excluded.last_outcome = 'success' then excluded.last_success_at else h.last_success_at end",
      ) &&
        helper.includes(
          "last_fail_at = case when excluded.last_outcome = 'fail' then excluded.last_fail_at else h.last_fail_at end",
        ),
      "only the timestamp for THIS outcome moves — writing both would erase the last success on the first failure",
    );
    assert.ok(helper.includes("on conflict (slug) do update set"), "one row per slug, upserted");
    assert.ok(
      /exception when others then raise warning/.test(helper),
      "a failed register write is a WARNING, never a failed job",
    );
    assert.ok(helper.includes("left(p_detail, 2000)"), "the detail is capped like recordJobHeartbeat's 2,000");
  }

  // ── Reachable by the service role only, like every function beside it ─────────────────────────
  for (const signature of ["phx_record_job_heartbeat(text, text, text)", "crm_agent_crm_ids_reconcile_run()"]) {
    assert.ok(
      sql.includes(`revoke execute on function public.${signature} from public, anon, authenticated;`),
      `${signature} is revoked from public, anon and authenticated`,
    );
    assert.ok(
      sql.includes(`grant execute on function public.${signature} to service_role;`),
      `${signature} is granted to service_role`,
    );
    assert.ok(
      !new RegExp(`grant execute on function public\\.${signature.replace(/[()]/g, "\\$&")} to (anon|authenticated)`).test(sql),
      `${signature} is never granted to a browser role`,
    );
  }

  // ── 4. The slug and cadence are the declared ones, and the row is in-house only ────────────────
  {
    const declared = findJobSchedule(SLUG);
    assert.ok(declared, `${SLUG} is declared in JOB_SCHEDULES — an undeclared slug is written and judged by nobody`);
    assert.equal(declared.kind, "cron");
    assert.equal(
      declared.schedule,
      "*/15 * * * *",
      "the declared cadence is the pg_cron one — Cairo's whole-hour offset leaves */15 the same instants in UTC",
    );
    assert.equal(declared.vendorSync, undefined, "it reads Phoenix's own tables, so the CRM cutover must never stand it down");
    assert.equal(declared.watchingSince, undefined, "a new declaration carries no watchingSince");

    const doc = read(DOC);
    const row = (parseDesiredChecks(doc) as Array<{ slug: string; externalSync: boolean }>).find(
      (check) => check.slug === SLUG,
    );
    assert.ok(row, `${SLUG} has a row in ${DOC}`);
    assert.equal(
      row.externalSync,
      false,
      "nothing pings Healthchecks for this job, so its row is in-house only — a sync asking for a check would fail at the ceiling for ever",
    );
    const meta = parseCheckMeta(doc).get(SLUG) as { tags: string[] } | undefined;
    assert.ok(meta, `${SLUG} has a tags/description row in ${DOC}`);
    assert.deepEqual([...meta.tags].sort(), ["crm", "in-house-only"]);
  }
}
