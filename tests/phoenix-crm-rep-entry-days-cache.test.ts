import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the entry days are cached, and there is still only ONE copy of the rule.
 *
 * "Phoenix wins the day" (owner, 2026-10-16) is the rule that a rep's iReports360 rows are dropped
 * on a day he also has a Phoenix entry, and `phoenix_crm_rep_entry_days()` is its one definition —
 * anti-joined by crm_visits_unified and crm_checkins_unified, and read by three TypeScript loaders.
 * Until 20261023091035 that function recomputed every entry day from all of Phoenix CRM's history
 * on every read of either door: 35.2 ms and 4,509 buffers of a 79.4 ms, 5,885-buffer read, paid once
 * per calendar day of the window because a company-wide window is read a day per request.
 *
 * It is now a table. Which means the rule can go wrong in a way it previously could not, and the two
 * ways are both silent:
 *
 * THE FIRST IS A SECOND COPY OF THE RULE. The cache has to be written by something, and the obvious
 * mistake is to write the membership test again in the writer — in `_touch`, in a trigger, in a
 * backfill script — at which point there are two definitions of "did this rep record a Phoenix
 * entry", they drift, and the figure that disagrees is a visit count on a manager's board. So every
 * write path here goes through `phoenix_crm_rep_entry_days_calc()`, the ONE body, and this file pins
 * that: `_calc` is the only thing in the migration that reads phoenix_crm_countable_visits or names
 * an activity type, and the public reader reads nothing but the cache table.
 *
 * THE SECOND IS A WRITE THAT DOES NOT REACH THE CACHE. A rep-day the cache misses means his
 * iReports360 rows are counted alongside his Phoenix ones for that day — double-counted, with
 * nothing red. Four fact tables decide the answer and each one is triggered; a fifth trigger rebuilds
 * on a team start, because that re-dates whole teams at once and has no single key. The two inputs
 * that are NOT triggered (employees, au.seats) are covered by the 5-minute reconcile, which is why
 * the reconcile is pinned here too rather than treated as housekeeping.
 *
 * The migration also refuses to COMMIT a cache that disagrees with _calc(), which is the only reason
 * it is safe to apply to a database holding real payroll: on production it backfilled 542 rows with
 * 0 differences, against the 542 the live computation returned beforehand.
 */

const MIGRATION = "supabase/migrations/20261023091035_phoenix_crm_rep_entry_days_cache.sql";

/** The migration with its comments removed, so no assertion below can be satisfied by prose. */
function sqlSource(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** One function's body out of the migration — between its header and its closing `$function$;`. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} is defined in ${MIGRATION}`);
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${name}'s body ends`);
  return sql.slice(start, end);
}

/** The nine activity types that count as a worked day — the rule's own list. */
const ACTIVITY_TYPES = [
  "meeting",
  "conference",
  "health_day",
  "sales_day",
  "training",
  "admin_work",
  "travel",
  "group_meeting",
  "rtd",
];

/** Every function the migration defines, and whether it may hold the rule. */
const DEFINER_FUNCTIONS = [
  { name: "phoenix_crm_rep_entry_days_calc", args: "text, date", holdsTheRule: true },
  { name: "phoenix_crm_rep_entry_days_rebuild", args: "", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days_touch", args: "text, date", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days_on_visit", args: "", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days_on_day_activity", args: "", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days_on_visit_child", args: "", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days_on_team_start", args: "", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days_reconcile", args: "", holdsTheRule: false },
  { name: "phoenix_crm_rep_entry_days", args: "", holdsTheRule: false },
];

/** Each fact table and the trigger function that must answer for it. */
const TRIGGERS = [
  { trigger: "phoenix_crm_rep_entry_days_visit", table: "phoenix_crm_visits", fn: "phoenix_crm_rep_entry_days_on_visit", each: "row" },
  { trigger: "phoenix_crm_rep_entry_days_day_activity", table: "phoenix_crm_day_activities", fn: "phoenix_crm_rep_entry_days_on_day_activity", each: "row" },
  { trigger: "phoenix_crm_rep_entry_days_unplanned", table: "phoenix_crm_unplanned_visits", fn: "phoenix_crm_rep_entry_days_on_visit_child", each: "row" },
  { trigger: "phoenix_crm_rep_entry_days_recording", table: "phoenix_crm_visit_recordings", fn: "phoenix_crm_rep_entry_days_on_visit_child", each: "row" },
  { trigger: "phoenix_crm_rep_entry_days_team_start", table: "phoenix_crm_team_starts", fn: "phoenix_crm_rep_entry_days_on_team_start", each: "statement" },
];

export async function runPhoenixCrmRepEntryDaysCacheTests(): Promise<void> {
  const sql = sqlSource();

  // ── ONE copy of the rule, and _calc is where it lives ────────────────────────────────────────
  {
    const calc = functionBody(sql, "phoenix_crm_rep_entry_days_calc");
    assert.ok(
      calc.includes("from public.phoenix_crm_countable_visits p"),
      "_calc counts a Phoenix visit through the countable view, never the raw table",
    );
    assert.ok(
      calc.includes("from public.phoenix_crm_day_activities a"),
      "_calc counts a recorded day activity as an entry day too",
    );
    for (const type of ACTIVITY_TYPES) {
      assert.ok(calc.includes(`'${type}'`), `_calc names the ${type} activity type`);
    }
    assert.ok(
      calc.includes("(p_day is null or p.visit_date = p_day)") &&
        calc.includes("(p_hr_key is null or lower(btrim(p.rep_hr_id)) = p_hr_key)"),
      "_calc narrows to one rep and one day for the triggers, and both arguments null is the whole history",
    );
  }

  // ── No second copy of it anywhere else in the migration ──────────────────────────────────────
  {
    // The membership test must appear ONCE. A writer that re-types it is the drift this whole file
    // exists to prevent, and it would look perfectly reasonable in review.
    for (const { name, holdsTheRule } of DEFINER_FUNCTIONS) {
      const body = functionBody(sql, name);
      if (holdsTheRule) continue;
      assert.equal(
        body.includes("phoenix_crm_countable_visits"),
        false,
        `${name} must not read phoenix_crm_countable_visits — the rule belongs to _calc alone`,
      );
      for (const type of ACTIVITY_TYPES) {
        assert.equal(
          body.includes(`'${type}'`),
          false,
          `${name} must not name the ${type} activity type — that is _calc's list`,
        );
      }
    }
  }

  // ── Both write paths recompute THROUGH _calc ─────────────────────────────────────────────────
  {
    for (const name of ["phoenix_crm_rep_entry_days_rebuild", "phoenix_crm_rep_entry_days_touch"]) {
      assert.ok(
        functionBody(sql, name).includes("from public.phoenix_crm_rep_entry_days_calc("),
        `${name} fills the cache from _calc`,
      );
    }
    assert.ok(
      functionBody(sql, "phoenix_crm_rep_entry_days_touch").includes(
        "public.phoenix_crm_rep_entry_days_calc(v_key, p_day)",
      ),
      "the single-key recompute asks _calc for exactly the key it is repairing",
    );
  }

  // ── The public reader reads the cache and nothing else ───────────────────────────────────────
  {
    const reader = functionBody(sql, "phoenix_crm_rep_entry_days");
    assert.ok(
      reader.includes("from public.phoenix_crm_rep_entry_days_cache c"),
      "every existing caller — both unified views and the three TypeScript loaders — now reads the table",
    );
    assert.equal(
      reader.includes("phoenix_crm_rep_entry_days_calc"),
      false,
      "the reader must NOT fall back to the live computation: that is the 35 ms this migration removed",
    );
    assert.ok(
      reader.includes("rows 400"),
      "the row estimate is unchanged on purpose, so no plan anywhere changes shape over a new estimate",
    );
    assert.ok(
      reader.includes("hr_key") && reader.includes("agent_crm_id") && reader.includes("entry_day"),
      "the three columns keep their names and order",
    );
  }

  // ── Every fact table that decides the answer is triggered ────────────────────────────────────
  {
    for (const { trigger, table, fn, each } of TRIGGERS) {
      assert.ok(
        sql.includes(`create trigger ${trigger}`),
        `${trigger} is created — without it a write to ${table} leaves the cache wrong`,
      );
      assert.ok(
        sql.includes(`after insert or update or delete on public.${table}`),
        `${trigger} fires on insert, update AND delete of ${table}`,
      );
      assert.ok(
        sql.includes(`for each ${each} execute function public.${fn}()`),
        `${trigger} runs ${fn} for each ${each}`,
      );
    }
    assert.equal(
      sql.split("create trigger ").length - 1,
      TRIGGERS.length,
      "exactly the five triggers above — a sixth would be an input nobody has written down",
    );
  }

  // ── An UPDATE recomputes the OLD key as well as the new one ──────────────────────────────────
  {
    // A visit moved to another day, or re-assigned to another rep, empties its old rep-day. Touching
    // only the new key leaves the old one claiming a Phoenix entry that no longer exists, which
    // silently drops that day's iReports360 rows for ever.
    for (const name of ["phoenix_crm_rep_entry_days_on_visit", "phoenix_crm_rep_entry_days_on_day_activity"]) {
      const body = functionBody(sql, name);
      assert.ok(body.includes("'UPDATE', 'DELETE'") && body.includes("old."), `${name} recomputes the old key`);
      assert.ok(body.includes("'INSERT', 'UPDATE'") && body.includes("new."), `${name} recomputes the new key`);
    }
  }

  // ── The reconcile, which covers every input the triggers do not watch ────────────────────────
  {
    const reconcile = functionBody(sql, "phoenix_crm_rep_entry_days_reconcile");
    assert.ok(reconcile.includes("except"), "the reconcile compares both directions, not just row counts");
    assert.ok(
      reconcile.includes("perform public.phoenix_crm_rep_entry_days_rebuild()"),
      "the reconcile REPAIRS a difference rather than only reporting one",
    );
    assert.ok(reconcile.includes("raise warning"), "and it says so, so a drift is not silent");
    assert.ok(
      sql.includes("'phoenix-crm-rep-entry-days-reconcile'") && sql.includes("'*/5 * * * *'"),
      "scheduled every 5 minutes — that interval IS the staleness bound for employees and au.seats",
    );
  }

  // ── The migration refuses to commit a cache that disagrees with the truth ────────────────────
  {
    assert.ok(
      sql.includes("if v_diff <> 0 then") &&
        sql.includes("raise exception 'phoenix_crm_rep_entry_days cache backfill disagrees"),
      "the backfill is verified inside the transaction and aborts rather than leaving a wrong cache",
    );
  }

  // ── Every SECURITY DEFINER function is closed to the browser keys ────────────────────────────
  {
    for (const { name, args } of DEFINER_FUNCTIONS) {
      const signature = `public.${name}(${args})`;
      assert.ok(
        sql.includes(`revoke execute on function ${signature} from public, anon, authenticated;`),
        `${name} revokes execute from public, anon and authenticated — revoking only the latter two is a no-op`,
      );
      assert.ok(
        sql.includes(`grant execute on function ${signature} to service_role;`),
        `${name} re-grants execute to service_role`,
      );
    }
    assert.equal(
      sql.split("security definer").length - 1,
      DEFINER_FUNCTIONS.length,
      "every definer function in the file is in the list above, so none escapes the revoke check",
    );
  }

  // ── The table itself ─────────────────────────────────────────────────────────────────────────
  {
    assert.ok(
      sql.includes("primary key (hr_key, entry_day)"),
      "one row per rep-day, which is what makes the anti-join an index lookup",
    );
    assert.ok(
      sql.includes("phoenix_crm_rep_entry_days_cache_crm_day_idx") && sql.includes("(agent_crm_id, entry_day)"),
      "the second anti-join matches on agent_crm_id — the vendor rows whose agent has no hr_id at all",
    );
    assert.ok(
      sql.includes("alter table public.phoenix_crm_rep_entry_days_cache enable row level security;"),
      "RLS on, and no grant to anon or authenticated",
    );
    assert.equal(
      sql.includes("to anon") || sql.includes("to authenticated;"),
      false,
      "nothing here is granted to a browser key",
    );
  }

  // ── The file is recorded as applied outside the ledger ───────────────────────────────────────
  {
    // apply-sql-file.mjs writes no schema_migrations row, so without this entry the drift sweep
    // reports it unapplied for ever — and the evidence is the digests, not the entry.
    const inventory = readFileSync(new URL("../scripts/lib/migration-inventory.ts", import.meta.url), "utf8");
    assert.ok(
      inventory.includes("20261023091035_phoenix_crm_rep_entry_days_cache.sql"),
      "the migration is in ACKNOWLEDGED_EXCEPTIONS with its md5 evidence",
    );
  }

  console.log("phoenix-crm rep entry days cache: OK");
}
