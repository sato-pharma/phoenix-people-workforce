import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * One employee row per HR id is a CACHED table now, and there is still only ONE copy of the rule.
 *
 * Both union doors need "the one employee row for this HR id, whatever the casing" — for the agent,
 * for each of the two partner slots, and for the two iReports360 name slots. Until 20261023153000
 * each of those seven sites carried its OWN copy of
 *
 *   select distinct on (upper(btrim(e.hr_id))) ... from public.employees e
 *    order by upper(btrim(e.hr_id)), e.hr_id
 *
 * so one read of one day's first page sorted and de-duplicated all 220 employees up to seven times.
 * Measured on production on 2026-10-23, nine interleaved runs of each shape against the same day:
 * 736 buffers and 16.73 ms of execution became 283 buffers and 11.09 ms.
 *
 * The table buys two new ways to be silently wrong, and this file pins both shut.
 *
 * THE FIRST IS A SECOND COPY OF THE RULE. The rule is not "the employee with this hr_id" — it is
 * `distinct on (upper(btrim(hr_id)))` with the tie broken by the lowest `hr_id`, and it exists
 * because TWO rows whose hr_ids differ only in case would otherwise double a visit outright. Written
 * a second time in the rebuild or the trigger it drifts, and what drifts is whether a visit is
 * counted once. So `crm_person_by_hr_key_calc()` holds the one body and every write path recomputes
 * THROUGH it.
 *
 * THE SECOND IS A WRITE THAT NEVER REACHES THE CACHE, which shows up as a stale name with nothing
 * red. `employees` is the only input, so one statement trigger covers it — but only for the columns
 * it names. All THREE of hr_id, crm_id and full_name decide the answer, and a trigger that forgets
 * one is a staleness hole no figure shows, so the column list is pinned here by name.
 *
 * The two name slots are NOT interchangeable: the iReports360 branch reads the blank-as-NULL name
 * (`full_name_nz`), because `case when agent_person.full_name_nz is not null` is what decides
 * whether the vendor's own spelling of the agent is kept, and an employee whose full_name is an
 * empty string must read as "no name on record". The five Phoenix sites read the raw column. Swap
 * them and the door still runs.
 */

const MIGRATION = "supabase/migrations/20261023153000_crm_person_by_hr_key_cache.sql";
const CACHE = "crm_person_by_hr_key_cache";

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

/** One `create or replace view public.<name>` statement, through the `;` that ends it. */
function viewSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace view public.${name}\n`);
  assert.notEqual(start, -1, `${name} is defined in ${MIGRATION}`);
  const end = sql.indexOf(";\n", start);
  assert.notEqual(end, -1, `${name} is closed`);
  return sql.slice(start, end);
}

/** Whitespace collapsed, so a pin reads the SQL and not its indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Everything in the migration EXCEPT `_calc()`'s own body — where a second copy of the rule would hide. */
function outsideCalc(sql: string): string {
  const start = sql.indexOf("create or replace function public.crm_person_by_hr_key_calc(");
  assert.notEqual(start, -1, "_calc is defined");
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, "_calc's body ends");
  return sql.slice(0, start) + sql.slice(end);
}

export async function runCrmPersonByHrKeyCacheTests(): Promise<void> {
  const sql = sqlSource();

  // ── The one body ───────────────────────────────────────────────────────────────────────────────
  {
    const calc = flat(functionBody(sql, "crm_person_by_hr_key_calc"));
    assert.ok(
      calc.includes("select distinct on (upper(btrim(e.hr_id)))") &&
        calc.includes("from public.employees e") &&
        calc.includes("order by upper(btrim(e.hr_id)), e.hr_id"),
      "_calc holds the rule the doors used to inline: one row per case-insensitive hr_id, lowest hr_id wins",
    );
    assert.ok(
      calc.includes("nullif(btrim(e.full_name), '') as full_name_nz"),
      "and it carries the blank-as-NULL name as its own column, so neither door's expression changes",
    );

    // Nothing else in the migration may read employees or re-state the rule.
    const rest = outsideCalc(sql);
    assert.ok(
      !rest.includes("from public.employees"),
      "crm_person_by_hr_key_calc() is the ONLY thing in this migration that reads public.employees",
    );
    assert.ok(
      !rest.includes("distinct on"),
      "and the ONLY thing that names distinct on — a second copy of the rule is what drifts",
    );
  }

  // ── Every write path recomputes through it ─────────────────────────────────────────────────────
  {
    const rebuild = flat(functionBody(sql, "crm_person_by_hr_key_rebuild"));
    assert.ok(
      rebuild.includes(`delete from public.${CACHE}`) &&
        rebuild.includes("from public.crm_person_by_hr_key_calc() c"),
      "the rebuild recomputes through _calc(), never from employees itself",
    );

    const onEmployee = flat(functionBody(sql, "crm_person_by_hr_key_on_employee"));
    assert.ok(
      onEmployee.includes("perform public.crm_person_by_hr_key_rebuild()"),
      "and the trigger does the same, through the rebuild",
    );

    const reconcile = flat(functionBody(sql, "crm_person_by_hr_key_reconcile"));
    assert.ok(
      reconcile.includes("except") && reconcile.includes("public.crm_person_by_hr_key_calc()"),
      "the reconcile compares VALUES against _calc(), not just keys",
    );
    assert.ok(
      reconcile.includes("perform public.crm_person_by_hr_key_rebuild()"),
      "and repairs what it finds",
    );
  }

  // ── The trigger names all three deciding columns ───────────────────────────────────────────────
  {
    const trigger = flat(sql.slice(sql.indexOf("create trigger crm_person_by_hr_key_sync")));
    assert.ok(
      trigger.startsWith(
        "create trigger crm_person_by_hr_key_sync after insert or delete or update of hr_id, crm_id, full_name on public.employees for each statement",
      ),
      "insert, delete and an update of ALL THREE deciding columns — a column left out is a staleness hole no figure shows",
    );
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
      "service_role alone writes it — exactly the reach the two doors already have",
    );
    for (const fn of [
      "crm_person_by_hr_key_calc(text)",
      "crm_person_by_hr_key_rebuild()",
      "crm_person_by_hr_key_on_employee()",
      "crm_person_by_hr_key_reconcile()",
    ]) {
      assert.ok(
        sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`),
        `${fn} is revoked from every browser role`,
      );
      assert.ok(sql.includes(`grant execute on function public.${fn} to service_role;`), `${fn} is granted to service_role`);
    }
  }

  // ── The migration refuses to commit on a disagreement ──────────────────────────────────────────
  {
    assert.ok(
      sql.includes("refusing to commit"),
      "the backfill checks itself against _calc() and raises rather than commit a cache that already disagrees",
    );
    assert.ok(
      sql.includes("'crm-person-by-hr-key-reconcile'") && sql.includes("'*/15 * * * *'"),
      "and the reconcile is scheduled every 15 minutes as the safety net",
    );
  }

  // ── Both doors read the cache, and no copy of the subquery is left ─────────────────────────────
  {
    for (const [view, joins] of [
      ["crm_visits_unified", 6],
      ["crm_checkins_unified", 1],
    ] as const) {
      const body = flat(viewSql(sql, view));
      assert.ok(
        !body.includes("distinct on (upper(btrim(e.hr_id)))"),
        `${view} carries no inline copy of the person lookup any more`,
      );
      const count = body.split(`left join public.${CACHE} `).length - 1;
      assert.equal(count, joins, `${view} joins the cache ${joins} time(s) — one per person slot it shows`);
    }

    const visits = flat(viewSql(sql, "crm_visits_unified"));
    // The two iReports360 name slots read the BLANK-AS-NULL name; the Phoenix slots read the raw one.
    for (const alias of ["agent_person", "double_person"]) {
      assert.ok(
        visits.includes(`case when ${alias}.full_name_nz is not null then`),
        `${alias} reads the blank-as-NULL name, so an employee with an empty name keeps the vendor's spelling`,
      );
      assert.ok(
        !visits.includes(`${alias}.full_name `) && !visits.includes(`${alias}.full_name,`),
        `and never the raw column, which would read an empty string as a name on record`,
      );
    }
    for (const alias of ["agent", "partner1", "partner2"]) {
      assert.ok(
        visits.includes(`left join public.${CACHE} ${alias} on ${alias}.hr_key = upper(btrim(`),
        `the ${alias} slot is a lookup in the cache, keyed on the same upper(btrim(hr_id))`,
      );
    }
  }

  // ── The file is recorded as applied outside the ledger ─────────────────────────────────────────
  {
    // apply-sql-file.mjs writes no schema_migrations row, so without this entry the drift sweep
    // reports it unapplied for ever — and the evidence is the digests, not the entry.
    const inventory = readFileSync(new URL("../scripts/lib/migration-inventory.ts", import.meta.url), "utf8");
    assert.ok(
      inventory.includes("20261023153000_crm_person_by_hr_key_cache.sql"),
      "the migration is in ACKNOWLEDGED_EXCEPTIONS with its md5 evidence",
    );
  }

  console.log("crm person-by-hr-key cache: OK");
}
