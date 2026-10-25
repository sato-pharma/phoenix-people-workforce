import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The attribution freshness sweep finds its months with a skip-scan, and four polled reads keep the
 * indexes that answer them (2026-10-25 production load audit, the second pass).
 *
 * The production database is a 2 GB box that restarted 11 times in 14 days while swapping about
 * 530 MB, so the cost that matters is pages dragged through memory. Measured on production:
 *
 *   - `au.f_refresh_stale_attribution_periods` built its candidate list with `select distinct
 *     f.period` over the whole sales rollup: 264 ms and 8,353 buffers per call, to find 11 months.
 *     The skip-scan with one LIMIT 1 validated-batch probe per month takes 16 ms and 1,479 buffers,
 *     and returned the same 11 months (0 on only one side).
 *   - `notification_events` `event_key like 'prefix%'`: 92 ms mean, 103,592 blocks read. The
 *     text_pattern_ops index answers it in 1.7 ms.
 *   - The Master Map change probe sorted 52,614 customer-map rows to keep one: 54 ms. 0.18 ms now.
 *   - The CRM sync's stale-run reaper read the whole run log to find 0 or 1 running row: 36 ms.
 *     0.1 ms now, and the live poller's deep-run read went from 11.9 ms to 1.0 ms.
 *
 * Four things are pinned, each by the failure it prevents:
 *   1. The probe stays a LATERAL ... LIMIT 1. Written as a plain EXISTS, the planner flattens it
 *      into a hash semi-join over the whole rollup and the 264 ms comes straight back, with every
 *      result still correct, so nothing but this test would notice.
 *   2. Everything around the candidate list is the 20260929200000 body, unchanged: the fingerprint
 *      comparison, the published-period exclusion on monthly_closing_publications (never locks),
 *      newest first, the limit and the refresh call.
 *   3. The four indexes exist with the columns the planner was measured using, in the plain
 *      IF NOT EXISTS form a migration's transaction can run.
 *   4. No later migration puts the whole-rollup DISTINCT back or drops an index.
 */

const MIGRATION_DIR = "supabase/migrations";
const MIGRATION = "20261026010000_db_load_sweep_skipscan_and_indexes.sql";
const PREVIOUS = "20260929200000_serialize_attribution_refresh.sql";
const SWEEP = "au.f_refresh_stale_attribution_periods";

const INDEXES = [
  {
    name: "notification_events_event_key_pattern_idx",
    on: "public.notification_events (event_key text_pattern_ops)",
    why: "a btree under the database's en_US.UTF-8 collation cannot answer a LIKE prefix, so withdrawing a notification read the whole 37 MB table",
  },
  {
    name: "sos_customer_map_active_updated_idx",
    on: "public.source_of_sales_customer_map (active, updated_at desc)",
    why: "the Master Map change probe sorted all 52,614 rows to keep one, every five minutes",
  },
  {
    name: "ireports360_visits_sync_runs_status_started_idx",
    on: "public.ireports360_visits_sync_runs (status, started_at)",
    why: "the live poller's deep-run read walks it backward (1.0 ms against 11.9)",
  },
  {
    name: "ireports360_visits_sync_runs_status_completed_idx",
    on: "public.ireports360_visits_sync_runs (status, completed_at desc)",
    why: "the stale-run reaper reads it (0.1 ms against 36, which read the whole run log)",
  },
] as const;

function read(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

/** Whitespace collapsed, so a pin reads the SQL and not its indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** The sweep's definition, from its header to its closing `$function$;` (the comment after is prose). */
function sweepBody(sql: string, file: string): string {
  const start = sql.indexOf(`create or replace function ${SWEEP}`);
  assert.notEqual(start, -1, `${file} defines ${SWEEP}`);
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${file}'s ${SWEEP} body ends`);
  return flat(sql.slice(start, end));
}

export function runDbLoadSweepSkipscanTests(): void {
  const sql = stripSqlComments(read(`${MIGRATION_DIR}/${MIGRATION}`));
  const body = sweepBody(sql, MIGRATION);

  // ── 1. The candidate list is a skip-scan with a LATERAL LIMIT 1 probe ────────────────────────
  assert.ok(
    !body.includes("select distinct f.period"),
    "the sweep must not DISTINCT the whole sales rollup again: 264 ms and 8,353 buffers a call on a box that swaps",
  );
  assert.ok(body.includes("with recursive periods(period) as ("), "the months come from a recursive skip-scan");
  assert.ok(
    body.includes(
      "select f.period from public.source_of_sales_fact_rollup f where f.period is not null order by f.period limit 1",
    ),
    "the skip-scan starts at the first non-null period, one index probe",
  );
  assert.ok(
    body.includes(
      "select f.period from public.source_of_sales_fact_rollup f where f.period > periods.period order by f.period limit 1",
    ),
    "each step jumps to the next period with one index probe — without the LIMIT 1 it reads every row of the period",
  );
  assert.ok(
    body.includes(
      "cross join lateral ( select 1 from public.source_of_sales_fact_rollup f join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated' where f.period = periods.period limit 1 ) validated",
    ),
    "each month is kept only when a VALIDATED batch holds a row of it, asked as a LATERAL ... LIMIT 1 — the question the old join asked",
  );
  assert.ok(
    !/exists \( select 1 from public\.source_of_sales_fact_rollup/.test(body),
    "the validated probe must stay LATERAL ... LIMIT 1: written as a plain EXISTS the planner flattens it into a hash semi-join over the whole rollup, and the 264 ms comes back with every result still correct",
  );

  // ── 2. Everything around the candidate list is the 20260929200000 body, unchanged ─────────────
  const previous = sweepBody(stripSqlComments(read(`${MIGRATION_DIR}/${PREVIOUS}`)), PREVIOUS);
  const headEnd = (text: string) => text.indexOf("select p.period from (");
  const tailStart = (text: string) => text.indexOf(") p left join au.monthly_attribution_rollup_meta m on m.period = p.period");
  for (const [text, file] of [
    [body, MIGRATION],
    [previous, PREVIOUS],
  ] as const) {
    assert.notEqual(headEnd(text), -1, `${file}'s sweep opens its candidate subquery`);
    assert.notEqual(tailStart(text), -1, `${file}'s sweep joins the candidates to the fingerprint meta`);
  }
  assert.equal(
    body.slice(0, headEnd(body)),
    previous.slice(0, headEnd(previous)),
    "the signature, SECURITY DEFINER, search_path, fingerprint and limit clamp are the 20260929200000 ones",
  );
  assert.equal(
    body.slice(tailStart(body)),
    previous.slice(tailStart(previous)),
    "after the candidate list the sweep is the 20260929200000 body unchanged: the stale-fingerprint test, the published exclusion, newest first, the limit and the refresh call",
  );
  assert.match(
    body,
    /not exists\s*\([\s\S]{0,200}?monthly_closing_publications[\s\S]{0,120}?unpublished_at is null/,
    "a published period is excluded, so it neither takes a slot nor is reported as refreshed",
  );
  assert.ok(
    !body.includes("monthly_closing_locks"),
    "the exclusion reads PUBLICATIONS, never locks: the live month has a lock row and no publication, and is the one that needs refreshing",
  );
  assert.ok(body.includes("order by p.period desc limit v_limit"), "newest first, up to the limit");
  assert.ok(
    body.indexOf("perform au.f_refresh_monthly_attribution(r.period);") < body.indexOf("return next r.period;"),
    "each month is refreshed before it is reported",
  );

  // ── Reachable by the service role only, and only after the function is (re)created ───────────
  const signature = `${SWEEP}(integer)`;
  const revokeAt = sql.indexOf(`revoke execute on function ${signature} from public, anon, authenticated;`);
  assert.notEqual(revokeAt, -1, `${signature} is revoked from public, anon and authenticated — it is SECURITY DEFINER`);
  assert.ok(
    sql.includes(`grant  execute on function ${signature} to service_role;`) ||
      sql.includes(`grant execute on function ${signature} to service_role;`),
    `${signature} keeps service_role, which is how the scheduler reaches it`,
  );
  assert.ok(
    revokeAt > sql.indexOf(`create or replace function ${SWEEP}`),
    "the revoke comes after the function is recreated, or CREATE would reset the ACL it just set",
  );
  assert.ok(
    !new RegExp(`grant\\s+execute on function ${SWEEP.replace(".", "\\.")}\\(integer\\) to (anon|authenticated|public)`).test(sql),
    `${signature} is never granted to a browser role`,
  );

  // ── 3. The four indexes, in the form a migration transaction can run ─────────────────────────
  const flatSql = flat(sql);
  for (const index of INDEXES) {
    assert.ok(
      flatSql.includes(`create index if not exists ${index.name} on ${index.on};`),
      `${index.name} must be created on ${index.on}: ${index.why}`,
    );
  }
  assert.ok(
    !/create\s+(unique\s+)?index\s+concurrently/i.test(sql),
    "a migration runs in a transaction and CONCURRENTLY refuses one — production builds each index concurrently by hand first, and this file's plain IF NOT EXISTS form is then a no-op",
  );
  assert.ok(
    !/create\s+unique\s+index[\s\S]{0,120}monthly_attribution_rollup/i.test(sql),
    "no unique index on au.monthly_attribution_rollup: the direct and indirect rows share a key by design",
  );

  // ── 4. No later migration undoes it ──────────────────────────────────────────────────────────
  const later = readdirSync(new URL(`../${MIGRATION_DIR}/`, import.meta.url))
    .filter((name) => name.endsWith(".sql") && name > MIGRATION)
    .sort();
  for (const name of later) {
    const text = stripSqlComments(read(`${MIGRATION_DIR}/${name}`));
    if (text.includes(`create or replace function ${SWEEP}`)) {
      const redefined = sweepBody(text, name);
      assert.ok(
        !redefined.includes("select distinct f.period"),
        `${name} puts the whole-rollup DISTINCT back into ${SWEEP} — 264 ms a call against 16`,
      );
      assert.ok(
        redefined.includes("cross join lateral ("),
        `${name} redefines ${SWEEP} without the LATERAL ... LIMIT 1 probe`,
      );
    }
    for (const index of INDEXES) {
      assert.ok(
        !new RegExp(`drop\\s+index\\s+(concurrently\\s+)?(if\\s+exists\\s+)?(public\\.)?${index.name}\\b`, "i").test(text),
        `${name} drops ${index.name}: ${index.why}`,
      );
    }
  }
}
