import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The departed-agent CRM exclusion reads a 254-row table now, and the table is the ONLY thing it
 * reads.
 *
 * `phx_crm_agent_crm_ids_for_hr_ids` answered "which CRM ids did these people visit under" by
 * running `select distinct v.agent_crm_id from public.crm_visits_unified v` on every cold exclusion
 * cache. Measured on production on 2026-10-23 with the live-shaped input (the 108 non-active
 * employees the live tier actually passes): 220 ms and 57,005 shared buffers, scanning ~136,000
 * visit rows and quicksorting 140,616 of them, to return 76 integers. The whole answer is 254
 * distinct (agent_hr_id, agent_crm_id) pairs.
 *
 * Dropping the duplicate index the day before (20261023181000) is what proved the shape, not the
 * index, is the cost: the plan moved to the surviving index and the time did not — 189 ms before,
 * 220 ms after. So the pairs are cached, and this file pins the three ways that can go silently
 * wrong.
 *
 * THE FIRST IS A SECOND COPY OF THE RULE. `crm_agent_crm_ids_calc()` holds the one body and every
 * write path recomputes THROUGH it; nothing else in the migration may read `crm_visits_unified`.
 *
 * THE SECOND IS AN UNQUALIFIED DELETE. The rebuild empties the cache, and `safeupdate` — preloaded
 * for `authenticator`, which is how PostgREST connects — refuses a DELETE with no WHERE clause
 * while a direct SQL session accepts one every time. That divergence killed a candidate's joining
 * form at 13:11:46 Cairo on 2026-10-23 (20261023154500). `where true` is pinned here by text.
 *
 * THE THIRD IS A FALLBACK. The door must NOT reach for `_calc()` when the cache is empty: the one
 * failure that matters is a cache that stopped being rebuilt, and a fallback would hide it behind
 * the slow path this change exists to remove — at the cost of the staleness the 15-minute reconcile
 * is the bound for. The same rule already holds for the rep-entry-days cache.
 */

const MIGRATION = "supabase/migrations/20261023190000_crm_agent_crm_ids_cache.sql";
const CACHE = "crm_agent_crm_ids_cache";
const DOOR = "phx_crm_agent_crm_ids_for_hr_ids";

/** The migration with its comments removed, so no assertion below can be satisfied by prose. */
function sqlSource(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** One function's body out of the migration — between its header and its closing `$function$;`. */
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

/** Everything in the migration EXCEPT `_calc()`'s own body — where a second copy of the rule would hide. */
function outsideCalc(sql: string): string {
  const start = sql.indexOf("create or replace function public.crm_agent_crm_ids_calc(");
  assert.notEqual(start, -1, "_calc is defined");
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, "_calc's body ends");
  return sql.slice(0, start) + sql.slice(end);
}

export async function runCrmAgentCrmIdsCacheTests(): Promise<void> {
  const sql = sqlSource();

  // ── The one body ───────────────────────────────────────────────────────────────────────────────
  {
    const calc = flat(functionBody(sql, "crm_agent_crm_ids_calc("));
    assert.ok(
      calc.includes("select distinct v.agent_hr_id, v.agent_crm_id") &&
        calc.includes("from public.crm_visits_unified v"),
      "_calc holds the body the door used to run, widened to the PAIR",
    );
    assert.ok(
      calc.includes("where v.agent_crm_id is not null"),
      "and keeps the door's own NULL filter, so the answer is the same set it always was",
    );
    assert.ok(
      calc.includes("returns table(agent_hr_id text, agent_crm_id bigint)"),
      "the pair is what it returns — the cache's two columns, in the cache's order",
    );

    const rest = outsideCalc(sql);
    assert.ok(
      !rest.includes("from public.crm_visits_unified"),
      "crm_agent_crm_ids_calc() is the ONLY thing in this migration that reads crm_visits_unified",
    );
  }

  // ── Every write path recomputes through it, and the DELETE carries a WHERE ────────────────────
  {
    const rebuild = flat(functionBody(sql, "crm_agent_crm_ids_rebuild("));
    assert.ok(
      rebuild.includes(`delete from public.${CACHE} where true;`),
      "the rebuild's DELETE carries `where true` — safeupdate refuses an unqualified one over PostgREST, and that is how the joining form died on 2026-10-23",
    );
    assert.ok(
      rebuild.includes("from public.crm_agent_crm_ids_calc() c"),
      "and it refills THROUGH _calc(), never from the view itself",
    );

    const reconcile = flat(functionBody(sql, "crm_agent_crm_ids_reconcile("));
    assert.ok(
      reconcile.includes("except") && reconcile.includes("public.crm_agent_crm_ids_calc()"),
      "the reconcile compares VALUES against _calc(), both ways",
    );
    assert.ok(
      reconcile.includes("perform public.crm_agent_crm_ids_rebuild()"),
      "and repairs what it finds",
    );
  }

  // ── The door reads the cache, and ONLY the cache ──────────────────────────────────────────────
  {
    const door = flat(functionBody(sql, `${DOOR}(p_agent_hr_ids text[])`));
    assert.ok(
      door.includes(`from public.${CACHE} c`) && door.includes("where c.agent_hr_id = any(p_agent_hr_ids)"),
      "the door probes the cache on its primary key",
    );
    assert.ok(
      door.includes("select distinct c.agent_crm_id"),
      "and still de-duplicates — a handed-over CRM slot puts one agent_crm_id under two agent_hr_ids",
    );
    assert.ok(
      !door.includes("crm_visits_unified") && !door.includes("crm_agent_crm_ids_calc"),
      "it does NOT fall back to the live computation: an empty cache must surface, not hide behind the slow path",
    );

    // reads.ts calls this by name through rpcAll and reads `agent_crm_id`; its PGRST202 page-walk
    // fallback depends on the function existing with exactly this signature. Any of these changing
    // is an app change, not a database one.
    for (const clause of [
      "returns table(agent_crm_id bigint)",
      "language sql",
      "stable",
      "security definer",
      "set search_path to 'public'",
      "set statement_timeout to '30s'",
    ]) {
      assert.ok(door.includes(clause), `the door keeps its \`${clause}\` — src/lib/crm/reads.ts is unchanged by this migration`);
    }
  }

  // ── Not reachable with a browser key ───────────────────────────────────────────────────────────
  {
    assert.ok(sql.includes(`alter table public.${CACHE} enable row level security;`), "the cache has RLS on");
    assert.ok(
      sql.includes(`revoke all on table public.${CACHE} from public, anon, authenticated;`),
      "and is revoked from every browser role",
    );
    assert.ok(
      sql.includes(`grant select, insert, update, delete on table public.${CACHE} to service_role;`),
      "service_role alone writes it — exactly the reach the door already has",
    );
    for (const fn of [
      "crm_agent_crm_ids_calc(text)",
      "crm_agent_crm_ids_rebuild()",
      "crm_agent_crm_ids_reconcile()",
      `${DOOR}(text[])`,
    ]) {
      assert.ok(
        sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`),
        `${fn} is revoked from every browser role`,
      );
      assert.ok(sql.includes(`grant execute on function public.${fn} to service_role;`), `${fn} is granted to service_role`);
    }
  }

  // ── The migration refuses to commit a cache that is already wrong ─────────────────────────────
  {
    assert.ok(
      sql.includes("disagrees with _calc() on % row(s) - refusing to commit"),
      "the backfill checks itself against _calc() and raises rather than commit a cache that already disagrees",
    );
    assert.ok(
      sql.includes("backfilled 0 rows - refusing to commit"),
      "and an empty backfill is a failure, not a quiet success — the door has no fallback to cover it",
    );
  }

  // ── The 15-minute reconcile is the staleness bound, not a safety net ──────────────────────────
  {
    // crm_visits_unified has ~10 input tables, so unlike crm_person_by_hr_key_cache there is no one
    // table to trigger on. Nothing else keeps this cache current.
    assert.ok(
      sql.includes("'crm-agent-crm-ids-reconcile'") && sql.includes("'*/15 * * * *'"),
      "the reconcile is scheduled every 15 minutes",
    );
    assert.ok(
      sql.includes("expected exactly one cron job named crm-agent-crm-ids-reconcile"),
      "and the migration asserts exactly one job of that name, so a re-apply cannot stack a second caller",
    );
    assert.ok(
      !sql.includes("create trigger"),
      "no trigger is claimed here — the view's ~10 inputs mean a trigger would cover only some of them, which reads as freshness it does not have",
    );
  }

  // ── The duplicate-index drop is recorded as applied outside the ledger ────────────────────────
  {
    // apply-sql-file.mjs writes no schema_migrations row, so without this entry the drift sweep
    // reports 20261023181000 unapplied for ever — and the evidence is the live index list, not the
    // entry. That file is the measurement this change rests on.
    const inventory = readFileSync(new URL("../scripts/lib/migration-inventory.ts", import.meta.url), "utf8");
    assert.ok(
      inventory.includes("20261023181000_crm_drop_duplicate_visits_agent_index.sql"),
      "the duplicate-index drop is in ACKNOWLEDGED_EXCEPTIONS with its evidence",
    );
  }

  console.log("crm agent-crm-ids cache: OK");
}
