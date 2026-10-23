import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The Phoenix contact truth is cached, and there is still only ONE copy of the winner rule.
 *
 * `crm_contact_phoenix_truth` answers "which Phoenix name and speciality win for this contact", and
 * THREE doors left-join it for the name they show: crm_visits_unified, crm_checkins_unified and
 * crm_plan_entries_unified. Until 20261023140001 it was `select distinct on (reference_contact_crm_id)
 * ... from phoenix_crm_customers`, and a join qual cannot be pushed into a `distinct on` — so every
 * read of every door built the whole thing and hashed it, whatever the page held. Measured on
 * production: 2,287 input rows hashed down to 2,285 winners, 240 blocks, on every call; one ordered
 * first page over an 83-day window spent 2,948 ms of which that hash was 96%.
 *
 * It is now a table, and that buys two new ways to be silently wrong.
 *
 * THE FIRST IS A SECOND COPY OF THE WINNER RULE. "Active first, then newest validated_at, then
 * newest updated_at" decides which of several customer rows supplies a contact's name. Written a
 * second time in a trigger or a backfill it drifts, and what drifts is the name a manager reads on a
 * visit. So `phoenix_crm_contact_truth_calc()` holds the one body and every write path recomputes
 * THROUGH it — pinned below: `_calc` is the only thing in the migration that reads
 * phoenix_crm_customers or names `distinct on`, and the view reads nothing but the cache.
 *
 * THE SECOND IS A WRITE THAT NEVER REACHES THE CACHE, which shows up as a stale or missing name with
 * nothing red. Here that is narrower than it was for the entry days: every column the truth reads
 * lives on phoenix_crm_customers, so ONE row trigger on insert, update AND delete covers every
 * input, and the reconcile is a safety net rather than a staleness bound. The UPDATE arm must
 * recompute the OLD reference too, or a row moved to another contact leaves the old contact holding
 * a name that no longer wins — that is pinned, because it is the one case a single-key trigger gets
 * wrong by default.
 *
 * `distinct on` is not removable and this file pins that reasoning stays true: the unique index is
 * per (seat_id, reference_contact_crm_id, is_test), so one contact legitimately has rows from several
 * seats, and 2 references already had more than one qualifying row when this was written.
 */

const MIGRATION = "supabase/migrations/20261023140001_crm_contact_phoenix_truth_cache.sql";
const CACHE = "crm_contact_phoenix_truth_cache";

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

/** Whitespace collapsed, so a pin reads the SQL and not its indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const DEFINER_FUNCTIONS: ReadonlyArray<[string, string]> = [
  ["phoenix_crm_contact_truth_calc", "bigint"],
  ["phoenix_crm_contact_truth_rebuild", ""],
  ["phoenix_crm_contact_truth_touch", "bigint"],
  ["phoenix_crm_contact_truth_on_customer", ""],
  ["phoenix_crm_contact_truth_on_truncate", ""],
  ["phoenix_crm_contact_truth_reconcile", ""],
];

export async function runCrmContactPhoenixTruthCacheTests(): Promise<void> {
  const sql = sqlSource();

  // ── ONE BODY ────────────────────────────────────────────────────────────────────────────────────
  const calc = flat(functionBody(sql, "phoenix_crm_contact_truth_calc"));

  assert.ok(
    calc.includes("select distinct on (c.reference_contact_crm_id)"),
    "the winner is chosen by distinct on, in _calc",
  );
  assert.ok(
    calc.includes("order by c.reference_contact_crm_id, (c.status = 'active') desc, c.validated_at desc, c.updated_at desc"),
    "and the winner rule itself: active first, then newest validated_at, then newest updated_at",
  );
  for (const clause of [
    "c.reference_contact_crm_id is not null",
    "c.validated_at is not null",
    "not c.is_test",
    "c.status = any (array['active', 'pending', 'dropped'])",
  ]) {
    assert.ok(calc.includes(clause), `_calc keeps the view's own filter: ${clause}`);
  }
  assert.ok(
    calc.includes("nullif(btrim(c.name), '') as name") && calc.includes("nullif(btrim(c.speciality), '') as speciality"),
    "and the view's own trimming, so a blank name still reads as absent",
  );
  assert.ok(
    calc.includes("(p_contact_crm_id is null or c.reference_contact_crm_id = p_contact_crm_id)"),
    "_calc narrows to one contact for the trigger, and both-null is the whole table",
  );

  // Only _calc may read the source table, or there are two definitions of the winner.
  const outsideCalc = sql.split("create or replace function public.phoenix_crm_contact_truth_calc(");
  assert.equal(outsideCalc.length, 2, "_calc is defined exactly once");
  const everythingElse = outsideCalc[0] + outsideCalc[1].slice(outsideCalc[1].indexOf("$function$;"));
  assert.ok(
    !everythingElse.includes("distinct on"),
    "nothing outside _calc re-states the winner rule",
  );
  assert.ok(
    !/from\s+public\.phoenix_crm_customers/.test(everythingElse),
    "and nothing outside _calc reads phoenix_crm_customers",
  );

  // ── BOTH WRITE PATHS GO THROUGH _calc ───────────────────────────────────────────────────────────
  const rebuild = flat(functionBody(sql, "phoenix_crm_contact_truth_rebuild"));
  const touch = flat(functionBody(sql, "phoenix_crm_contact_truth_touch"));

  assert.ok(
    rebuild.includes("from public.phoenix_crm_contact_truth_calc() f"),
    "the rebuild fills the cache through _calc",
  );
  assert.ok(
    touch.includes("from public.phoenix_crm_contact_truth_calc(p_contact_crm_id) f"),
    "and so does the single-contact touch, with the narrowing argument",
  );
  assert.ok(
    rebuild.includes(`delete from public.${CACHE} c where not exists`),
    "the rebuild drops cached contacts the rule no longer returns",
  );
  assert.ok(
    touch.includes("if p_contact_crm_id is null then return;"),
    "a null contact is a no-op rather than a whole-table rewrite",
  );

  // ── THE VIEW KEEPS ITS CONTRACT ─────────────────────────────────────────────────────────────────
  const viewStart = sql.indexOf("create or replace view public.crm_contact_phoenix_truth");
  assert.notEqual(viewStart, -1, "the view is redefined");
  const view = flat(sql.slice(viewStart, sql.indexOf(";", viewStart) + 1));

  assert.ok(view.includes("with (security_invoker = true)"), "the view stays security_invoker");
  assert.ok(
    view.includes("select c.contact_crm_id, c.name, c.speciality") && view.includes(`from public.${CACHE} c`),
    "the view reads the cache, with the same three columns in the same order",
  );
  assert.ok(
    !view.includes("phoenix_crm_contact_truth_calc"),
    "and never falls back to the live computation — that is what a door would pay for on every read",
  );
  assert.ok(
    !/create or replace view public\.(crm_visits_unified|crm_checkins_unified|crm_plan_entries_unified)/.test(sql),
    "NO DOOR IS EDITED by this migration: the three unified views are untouched, which is why they got this for free",
  );

  // ── THE TRIGGERS ────────────────────────────────────────────────────────────────────────────────
  const onCustomer = flat(functionBody(sql, "phoenix_crm_contact_truth_on_customer"));
  assert.ok(
    onCustomer.includes("if tg_op in ('UPDATE', 'DELETE') then perform public.phoenix_crm_contact_truth_touch(old.reference_contact_crm_id);"),
    "an UPDATE or DELETE recomputes the OLD contact — a row moved away otherwise leaves a name that no longer wins",
  );
  assert.ok(
    onCustomer.includes("if tg_op in ('INSERT', 'UPDATE') then perform public.phoenix_crm_contact_truth_touch(new.reference_contact_crm_id);"),
    "and an INSERT or UPDATE recomputes the new one",
  );

  assert.match(
    sql,
    /create trigger phoenix_crm_contact_truth_customer\s+after insert or update or delete on public\.phoenix_crm_customers\s+for each row execute function public\.phoenix_crm_contact_truth_on_customer\(\);/,
    "the row trigger covers insert, update AND delete on the one table that feeds the truth",
  );
  assert.match(
    sql,
    /create trigger phoenix_crm_contact_truth_customer_truncate\s+after truncate on public\.phoenix_crm_customers\s+for each statement execute function public\.phoenix_crm_contact_truth_on_truncate\(\);/,
    "and a TRUNCATE, which fires no row trigger at all, rebuilds",
  );
  assert.equal(
    sql.split("create trigger ").length - 1,
    2,
    "exactly two triggers — one table feeds this truth, so a third would be a second definition of when to recompute",
  );

  // ── THE SAFETY NET ──────────────────────────────────────────────────────────────────────────────
  const reconcile = flat(functionBody(sql, "phoenix_crm_contact_truth_reconcile"));
  assert.ok(reconcile.includes("except"), "the reconcile compares the cache with _calc");
  assert.ok(
    reconcile.includes("perform public.phoenix_crm_contact_truth_rebuild();"),
    "and repairs through the one rebuild path",
  );
  assert.ok(
    reconcile.includes("raise warning"),
    "and says so, rather than repairing in silence",
  );
  assert.ok(
    reconcile.includes("contact_crm_id, name, speciality from public.phoenix_crm_contact_truth_calc() except select contact_crm_id, name, speciality from public." + CACHE),
    "it compares the VALUES, not just which contacts are present — a stale name is the failure that matters",
  );
  assert.match(
    sql,
    /'phoenix-crm-contact-truth-reconcile',\s*'\*\/15 \* \* \* \*'/,
    "scheduled every 15 minutes: every input is triggered, so this is a safety net and not the staleness bound",
  );

  // ── THE MIGRATION REFUSES TO COMMIT A CACHE THAT DISAGREES ──────────────────────────────────────
  assert.ok(
    sql.includes("raise exception 'crm_contact_phoenix_truth cache backfill disagrees with phoenix_crm_contact_truth_calc()"),
    "the backfill refuses to commit unless the cache and the rule agree row for row",
  );

  // ── NOTHING REACHABLE WITH A BROWSER KEY ────────────────────────────────────────────────────────
  for (const [name, args] of DEFINER_FUNCTIONS) {
    assert.ok(
      sql.includes(`revoke execute on function public.${name}(${args}) from public, anon, authenticated;`),
      `${name} revokes execute from public, anon and authenticated`,
    );
    assert.ok(
      sql.includes(`grant execute on function public.${name}(${args}) to service_role;`),
      `${name} re-grants execute to service_role only`,
    );
  }
  assert.equal(
    sql.split("security definer").length - 1,
    DEFINER_FUNCTIONS.length,
    `exactly ${DEFINER_FUNCTIONS.length} security definer functions — a new one needs its own revoke and grant above`,
  );

  assert.ok(
    sql.includes(`alter table public.${CACHE} enable row level security;`),
    "the cache has RLS enabled",
  );
  assert.ok(
    sql.includes(`revoke all on table public.${CACHE} from anon, authenticated;`),
    "and holds no grant for either browser key",
  );
  assert.ok(
    sql.includes("primary key (contact_crm_id)"),
    "the primary key is the whole point: it is what lets the doors look a contact up instead of hashing all 2,285",
  );

  // ── APPLIED BY HAND, SO IT MUST BE ACKNOWLEDGED ─────────────────────────────────────────────────
  const inventory = readFileSync(new URL("../scripts/lib/migration-inventory.ts", import.meta.url), "utf8");
  assert.ok(
    inventory.includes("20261023140001_crm_contact_phoenix_truth_cache.sql"),
    "the migration went through apply-sql-file.mjs, which writes no ledger row, so it is listed in ACKNOWLEDGED_EXCEPTIONS",
  );

  console.log("crm_contact_phoenix_truth cache: OK");
}
