import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the team starts table keeps its planner statistics.
 *
 * `public.phoenix_crm_team_starts` is 21 rows, and until 20261024190000 it had NEVER been analyzed
 * on production: `pg_class.reltuples` read -1, `relpages` 0, `pg_stats` held zero columns for it,
 * `pg_stat_all_tables.analyze_count` was 0. A table with no statistics is planned from a hard-coded
 * guess — 10 pages, 350 rows — and the two CRM union doors read this one five times between them:
 *
 *   Seq Scan on phoenix_crm_team_starts t_1  (cost=0.00..13.50 rows=350 ...) (actual ... rows=21 ...)
 *
 * three times in `crm_visits_unified` (t_1, run, s) and twice in `crm_checkins_unified` (t, t_1).
 * A 16-fold over-estimate of the table every door uses to decide which days belong to Phoenix and
 * which to iReports360 — and the planner picks join orders and join strategies from it. After the
 * migration all five nodes read `rows=21` at `cost=0.00..1.21`.
 *
 * TWO STATEMENTS, AND NEITHER ONE IS ENOUGH ALONE, which is the whole point of this file:
 *
 *   - ANALYZE alone fills the hole once and the next restore re-opens it. Autovacuum analyzes when
 *     `n_mod_since_analyze > analyze_threshold + analyze_scale_factor * reltuples`; at the cluster
 *     defaults (50 and 0.1) that is 50 modifications, and a table of one row per team start cannot
 *     reach 50 in any reasonable time. The hole was PERMANENT, not slow to heal.
 *   - the per-table threshold alone changes nothing today: it only decides when autovacuum will
 *     next look, and a table sitting at `n_mod_since_analyze = 0` is never looked at again.
 *
 * So this test pins both, and pins that the threshold is genuinely below the default this table
 * cannot reach. It also refuses a locking statement in the same file: both doors read this table on
 * every request, and `vacuum full` or a `reindex` here would hold an ACCESS EXCLUSIVE lock across
 * them for no statistical gain.
 *
 * 🔴 The trap in the account is the reason the measurement is written down rather than re-run:
 * ANALYZE is only HALF-transactional. A rollback undoes the `pg_statistic` rows but NOT
 * `pg_class.reltuples`/`relpages` — an in-place, non-MVCC catalog update — so an ANALYZE probed
 * inside a rolled-back transaction leaves the table reading `reltuples = 21` with zero `pg_stats`
 * columns, and `reltuples = -1` no longer detects the hole it left behind.
 */

const MIGRATION = "supabase/migrations/20261024190000_phoenix_crm_team_starts_keeps_its_planner_statistics.sql";
const SWEEP = "supabase/migrations/20261024200000_every_table_with_data_and_no_statistics_gets_them.sql";
const NIGHTLY = "supabase/migrations/20261025230153_analyze_tables_with_no_statistics_nightly.sql";

/** The three small CRM door tables that get the per-table threshold, and the only ones that may. */
const OVERRIDDEN = ["phoenix_crm_day_starts", "phoenix_crm_manager_visits", "phoenix_crm_visit_edits"] as const;
const ACCOUNT = "docs/crm-team-starts-statistics.md";
const TABLE = "public.phoenix_crm_team_starts";

/**
 * Statements that take an ACCESS EXCLUSIVE lock (or remove data) — never in a statistics migration:
 * crm_visits_unified and crm_checkins_unified read these tables on every request.
 */
const FORBIDDEN = [/vacuum\s+full/i, /\breindex\b/i, /\bdrop\s+table\b/i, /\btruncate\b/i, /\block\s+table\b/i] as const;

function assertNoLockingStatements(sql: string, label: string): void {
  for (const forbidden of FORBIDDEN) {
    assert.equal(forbidden.test(sql), false, `no ${String(forbidden)} in ${label} — it would lock tables the two CRM doors read on every request`);
  }
}

/**
 * True when every `reltuples` in the SQL is `reltuples <> 0` (a table that holds rows). Any other read —
 * `= -1`, `< 0`, `::int < 0`, `in (-1)` — would be the "has no statistics" signal, and ANALYZE is only
 * half-transactional, so a rolled-back one clears that sentinel and leaves the statistics missing. An
 * allow-list, so a spelling nobody thought of fails rather than passes.
 */
function readsReltuplesOnlyAsHoldsRows(sql: string): boolean {
  const every = sql.match(/\breltuples\b/gi) ?? [];
  const holdsRows = sql.match(/\breltuples\s*<>\s*0\b/gi) ?? [];
  return every.length === holdsRows.length;
}

/** A migration with its comments removed, so no assertion below can be satisfied by prose. */
function sqlSource(file: string = MIGRATION): string {
  return stripSqlComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

export async function runPhoenixCrmTeamStartsStatisticsTests(): Promise<void> {
  const sql = sqlSource();

  // ── The migration exists, and it is about this one table ────────────────────────────────────
  {
    assert.ok(sql.trim().length > 0, `${MIGRATION} has statements, not only prose`);
    // Every `alter table`, in any spelling — `if exists`, `only`, schema-qualified or not — and it names
    // this table.
    const alters = [...sql.matchAll(/\balter\s+table\b(?:\s+if\s+exists)?(?:\s+only)?\s+("?[\w.]+"?)/gi)];
    assert.equal(alters.length, (sql.match(/\balter\s+table\b/gi) ?? []).length, "every alter table names its target plainly");
    assert.equal(alters.length, 1, "exactly one table is altered");
    assert.match(alters[0][1].replace(/"/g, ""), /^(public\.)?phoenix_crm_team_starts$/i, `the altered table is ${TABLE}`);
  }

  // ── Statement 1: a threshold this table's own traffic can actually reach ────────────────────
  {
    const threshold = /autovacuum_analyze_threshold\s*=\s*(\d+)/i.exec(sql);
    assert.ok(threshold, "the migration sets autovacuum_analyze_threshold on the table");
    const value = Number(threshold![1]);
    assert.ok(
      value > 0 && value < 50,
      `the per-table threshold (${value}) is below the cluster default of 50, which a 21-row table cannot reach`,
    );

    const scale = /autovacuum_analyze_scale_factor\s*=\s*([\d.]+)/i.exec(sql);
    assert.ok(scale, "the migration sets autovacuum_analyze_scale_factor too");
    assert.equal(
      Number(scale![1]),
      0,
      "the scale factor is 0, so the threshold above is the whole rule and not 10% of reltuples on top of it",
    );
  }

  // ── Statement 2: the hole is filled NOW, not merely scheduled ──────────────────────────────
  {
    assert.match(
      sql,
      /\banalyze\s+public\.phoenix_crm_team_starts\s*;/i,
      "the migration runs ANALYZE itself — the threshold alone leaves the table at n_mod_since_analyze = 0, never looked at again",
    );
  }

  // ── Nothing here may lock a table both doors read on every request ─────────────────────────
  {
    assertNoLockingStatements(sql, MIGRATION);
    assert.ok(sql.includes("begin;") && sql.includes("commit;"), "the file is one transaction, like every other migration here");
  }

  // ── The measurement survives, because it cannot be re-taken cheaply ────────────────────────
  {
    // The before-image is gone the moment the migration runs, and ANALYZE's effect on reltuples is
    // not transactional, so nobody can re-measure the 350-row guess without breaking the fix.
    assert.ok(existsSync(new URL(`../${ACCOUNT}`, import.meta.url)), `${ACCOUNT} holds the account`);
    const doc = readFileSync(new URL(`../${ACCOUNT}`, import.meta.url), "utf8");
    for (const needle of [
      "rows=350",
      "rows=21",
      "reltuples",
      "half-transactional",
      // the sweep's own measurement, which has the same problem: the before-image is gone
      "20261024200000_every_table_with_data_and_no_statistics_gets_them.sql",
      "29 → **9**",
    ]) {
      assert.ok(doc.includes(needle), `${ACCOUNT} still carries "${needle}"`);
    }
  }

  // -- The sweep: 29 OTHER tables held data with no statistics at all ------------------------
  //
  // Measured on production right after 20261024190000 landed: 532 ordinary `public` tables, 237
  // with zero `pg_stats` rows. 208 of those are empty and need nothing -- an empty table that HAS
  // been analyzed also holds no `pg_stats` rows, so the two are indistinguishable and equally
  // harmless. The other 29 held data and no statistics, and every one of them was being planned
  // from the same hard-coded 10-page / 350-row guess the team starts door was.
  {
    const sweep = sqlSource(SWEEP);
    assert.ok(sweep.trim().length > 0, `${SWEEP} has statements, not only prose`);

    // The threshold override goes ONLY on the three door tables that stay small for ever. A table
    // that later grows into the thousands would re-analyze itself after every 5 modifications,
    // which costs more than the bad estimate it buys -- so this list must not quietly widen.
    const alters = [
      ...sweep.matchAll(/alter\s+table(?:\s+if\s+exists)?\s+public\.(\w+)\s+set\s*\(([^)]*)\)/gi),
    ].map((match) => ({ table: match[1].toLowerCase(), options: match[2] }));
    assert.equal(
      (sweep.match(/alter\s+table/gi) ?? []).length,
      alters.length,
      "every `alter table` in the sweep is a `set (...)` of storage parameters and nothing else",
    );
    assert.deepEqual(
      alters.map((clause) => clause.table).sort(),
      [...OVERRIDDEN].sort(),
      "the per-table autovacuum threshold is set on the three small door tables and on nothing else",
    );
    for (const { table, options } of alters) {
      const threshold = /autovacuum_analyze_threshold\s*=\s*(\d+)/i.exec(options);
      assert.ok(threshold, `${table} gets an autovacuum_analyze_threshold`);
      const value = Number(threshold![1]);
      assert.ok(value > 0 && value < 50, `${table}'s threshold (${value}) is below the 50 rows it can never reach`);
      assert.match(
        options,
        /autovacuum_analyze_scale_factor\s*=\s*0(?:\.0+)?\s*(?:,|$)/i,
        `${table}'s scale factor is zero, so the threshold is the whole rule and not 10% on top of it`,
      );
    }

    // The sweep must find its targets through `pg_stats`, never through `reltuples`. ANALYZE is
    // only half-transactional: a rolled-back probe keeps the in-place `pg_class` row estimate and
    // drops the column statistics, so a table can read a perfectly plausible `reltuples` with no
    // statistics behind it. Keying on `reltuples = -1` reads exactly those tables as healthy, and
    // that is how the first sweep of this work reported "0 never-analyzed tables" on a schema with
    // 29 blind ones.
    assert.match(sweep, /from\s+pg_stats\b/i, "the sweep asks pg_stats which tables have no column statistics");
    assert.ok(
      readsReltuplesOnlyAsHoldsRows(sweep),
      "the sweep reads reltuples only as `reltuples <> 0`, never as -1 or < 0 --a rolled-back ANALYZE clears that sentinel and leaves the statistics missing",
    );

    // A second run of the file must select nothing: `relpages > 0` keeps the 208 empty tables out,
    // and `reltuples <> 0` keeps out the nine that hold pages but no live rows, where ANALYZE
    // produces no `pg_stats` rows at all and so would match again on every single run.
    assert.match(sweep, /relpages\s*>\s*0/i, "the sweep skips a table with no pages");
    assert.match(
      sweep,
      /reltuples\s*<>\s*0/i,
      "the sweep skips a table with pages but no live rows, so re-running the file is a genuine no-op",
    );

    // One dynamic ANALYZE, not a hard-coded table list: the set differs between staging and
    // production, and a literal `analyze public.x` for a table a project does not have would fail
    // the whole migration.
    assert.match(sweep, /execute\s+format\(\s*'analyze %s'/i, "the sweep analyzes through one dynamic statement");
    assert.equal(
      /\banalyze\s+public\.\w+/i.test(sweep),
      false,
      "no table is named in a literal ANALYZE -- the set is not the same on staging and production",
    );

    assertNoLockingStatements(sweep, SWEEP);
  }

  // -- The nightly sweep: the one-off becomes a pg_cron job, with five selection fixes ----------
  //
  // 20261024200000 ran once, at apply time; a table created, restored or refilled afterwards sat on
  // the 350-row guess again. The nightly job re-runs the selection and corrects it in five places.
  {
    const nightly = sqlSource(NIGHTLY);
    assert.ok(nightly.trim().length > 0, `${NIGHTLY} has statements, not only prose`);

    // 1. pg_statistic, not pg_stats: the view hides rows by column privilege and row security, so a
    //    table that HAS statistics could read as one with none and be re-analyzed (and counted) forever.
    assert.match(nightly, /pg_catalog\.pg_statistic\b/i, "the nightly sweep reads pg_catalog.pg_statistic");
    assert.equal(/\bfrom\s+(pg_catalog\.)?pg_stats\b/i.test(nightly), false, "the nightly sweep never asks the filtered pg_stats view");
    // 2. only a table the running role can analyze, so the count is of analyzes that really ran.
    assert.match(nightly, /has_table_privilege\(\s*c\.oid\s*,\s*'MAINTAIN'\s*\)/i, "the nightly sweep keeps only tables it may ANALYZE");
    // 3. a table with pages and no live rows comes back as soon as it is written to.
    assert.match(nightly, /relpages\s*>\s*0/i, "the nightly sweep skips a table with no pages");
    assert.match(nightly, /n_mod_since_analyze/i, "an emptied table that is written to again is picked up through n_mod_since_analyze");
    assert.ok(readsReltuplesOnlyAsHoldsRows(nightly), "the nightly sweep reads reltuples only as `reltuples <> 0`, never as the statistics signal");
    // 4. unlogged tables fall into the same hole, so they are swept too.
    assert.match(nightly, /relpersistence\s+in\s*\(\s*'p'\s*,\s*'u'\s*\)/i, "the nightly sweep covers unlogged tables as well as permanent ones");
    // 5. a table ANALYZE can never describe (no columns, or all at statistics 0) is left out, or it
    //    would be analyzed and counted every night for ever.
    assert.match(
      nightly,
      /coalesce\(\s*a\.attstattarget\s*,\s*-1\s*\)\s*<>\s*0/i,
      "the nightly sweep leaves out a table with no column ANALYZE can describe",
    );

    assert.match(nightly, /execute\s+format\(\s*'analyze %s'/i, "the nightly sweep analyzes through one dynamic statement");
    assert.equal(/\banalyze\s+public\.\w+/i.test(nightly), false, "no table is named in a literal ANALYZE");
    assertNoLockingStatements(nightly, NIGHTLY);

    // Every ANALYZE in a run holds its lock until the run ends, so the sweep waits a bounded time for
    // each one and skips a busy table, catching that and nothing else.
    const sweepAt = nightly.search(/create\s+or\s+replace\s+function\s+public\.phx_analyze_tables_without_statistics\(\)/i);
    assert.ok(sweepAt !== -1, "the sweep function exists");
    const sweepFn = nightly.slice(sweepAt, nightly.indexOf("$function$;", sweepAt));
    assert.match(sweepFn, /\bset\s+lock_timeout\s+to\s+'\d+s'/i, "the sweep bounds each lock wait with its own lock_timeout");
    const handlers = sweepFn.match(/\bexception\b/gi) ?? [];
    const busyOnly = sweepFn.match(/\bexception\s+when\s+lock_not_available\s+then\b/gi) ?? [];
    assert.ok(busyOnly.length >= 1, "the sweep skips a table it cannot lock in time");
    assert.equal(handlers.length, busyOnly.length, "the sweep catches lock_not_available and nothing else");

    // The pg_cron guard. The wrapper's order and catch-nothing rule, its grants, the cron.schedule
    // command and the JOB_SCHEDULES declaration are pinned with every other heartbeat job in
    // tests/pg-cron-heartbeats.test.ts.
    assert.match(
      nightly,
      /if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_extension\s+where\s+extname\s*=\s*'pg_cron'\s*\)/i,
      "the schedule is guarded on pg_cron",
    );
  }

  console.log("phoenix-crm team starts statistics: OK");
}
