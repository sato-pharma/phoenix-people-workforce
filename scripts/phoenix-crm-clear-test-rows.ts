/**
 * Build the SQL that clears every Phoenix CRM TEST row from one database.
 *
 * Owner's instruction, 2026-10-09: "remoive all test enteries". The rows are not a leak — they are
 * produced by his own test-persona feature (ten active `app_auth_users.is_test_persona` accounts,
 * each mirroring a real employee), so they keep accumulating and clearing them is a recurring job
 * rather than a one-off. The personas themselves are never touched: their worlds simply go empty.
 *
 * This script TOUCHES NO DATABASE. It prints one .sql file to stdout, and the existing, audited
 * apply step runs it:
 *
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     scripts/phoenix-crm-clear-test-rows.ts > clear-crm-test-rows.sql
 *   node scripts/apply-sql-file.mjs clear-crm-test-rows.sql staging
 *
 * On PRODUCTION that apply is a BULK DESTRUCTIVE change, and production has NO point-in-time
 * recovery — seven daily backups are the whole recovery story (AGENTS.md section 2.3, section 8).
 * Announce it in plain words first.
 *
 * WHY THIS IS A SCRIPT AND NOT A HAND-WRITTEN DELETE. Three things make a naive `where is_test`
 * sweep wrong, and each cost a real error on 2026-10-09 while the first one was being written:
 *
 *  1. `phoenix_crm_countable_visits` is a VIEW over `phoenix_crm_visits` and it HAS an `is_test`
 *     column. A `pg_class`-wide inventory counts its rows a second time, and a delete against it
 *     errors. Its rows clear themselves with the visits. The emitted file asserts it is still a
 *     view, so if it is ever materialised the run aborts instead of quietly leaving rows behind.
 *  2. Ten child tables carry no `is_test` column at all (seven on 2026-10-09, plus the district
 *     manager's plan slots, ticked customers and events from 20261017000000), so a flag-only delete
 *     fails on their foreign keys. They are reached through a parent — see FLAGLESS_CHILDREN. Two of their column
 *     names do not read the way you would guess: `phoenix_crm_plan_edit_request_events` is keyed on
 *     `request_id`, and `phoenix_crm_unplanned_visit_events.visit_id` is a uuid matching
 *     `phoenix_crm_unplanned_visits.visit_id` — NOT that table's bigint `id`, which answers
 *     `operator does not exist: uuid = bigint`.
 *  3. The order is the whole difficulty, and it rots. The emitted file therefore asks the database
 *     itself, before deleting anything, whether any table references a parent this clears without
 *     being cleared first — so a CRM child table added next month aborts the run WITH ITS NAME
 *     rather than failing halfway through on a foreign key nobody can place.
 *
 * `planProblems` is the same check in TypeScript, pinned by tests/phoenix-crm-clear-test-rows.test.ts
 * against the foreign-key graph as production answered it on 2026-10-09.
 */

/** One foreign key, as `pg_constraint` reports it. `onDelete` is `confdeltype`. */
export type FkEdge = { child: string; parent: string; onDelete: string };

/**
 * One delete. `by` records WHY the rows are selected the way they are: `flag` means the table
 * carries `is_test` itself, `parent` means it does not and the rows are reached through a parent.
 */
export type Step = { table: string; by: "flag" | "parent"; where: string };

/** A view, not a table. Never in the plan. */
export const COUNTABLE_VISITS_VIEW = "phoenix_crm_countable_visits";

/** The CRM child tables with no `is_test` column of their own (production, read 2026-10-09). */
export const FLAGLESS_CHILDREN = [
  "phoenix_crm_plan_items",
  "phoenix_crm_plan_events",
  "phoenix_crm_plan_activities",
  "phoenix_crm_plan_day_starts",
  "phoenix_crm_plan_edit_request_events",
  "phoenix_crm_monthly_plan_events",
  "phoenix_crm_unplanned_visit_events",
  // The district manager's weekly plan (20261017000000): its slots, its ticked customers and its
  // trail hang off the plan header and carry no flag of their own.
  "phoenix_crm_manager_plan_slots",
  "phoenix_crm_manager_plan_customers",
  "phoenix_crm_manager_plan_events",
] as const;

const TEST_PLANS = "select id from phoenix_crm_plans where is_test";
const TEST_MANAGER_PLANS = "select id from phoenix_crm_manager_plans where is_test";
const TEST_MANAGER_SLOTS = `select id from phoenix_crm_manager_plan_slots where plan_id in (${TEST_MANAGER_PLANS})`;
const TEST_MANAGER_CUSTOMERS = "select id from phoenix_crm_manager_customers where is_test";
const TEST_CUSTOMERS = "select id from phoenix_crm_customers where is_test";
const TEST_PLACES = "select id from phoenix_crm_places where is_test";
const TEST_VISITS = "select id from phoenix_crm_visits where is_test";

/**
 * Child-first. Every entry becomes one `delete from <table> where <where>`, in this order, inside
 * one transaction. The emitted guard checks this coverage against the live schema before any of it
 * runs, and `planProblems` checks the ORDER in the unit suite.
 */
export const DELETE_PLAN: readonly Step[] = [
  // The plan tree. plan_items is reachable three ways, not one.
  {
    table: "phoenix_crm_plan_items",
    by: "parent",
    where: `plan_id in (${TEST_PLANS}) or customer_id in (${TEST_CUSTOMERS}) or place_id in (${TEST_PLACES})`,
  },
  { table: "phoenix_crm_plan_events", by: "parent", where: `plan_id in (${TEST_PLANS})` },
  { table: "phoenix_crm_plan_activities", by: "parent", where: `plan_id in (${TEST_PLANS})` },
  { table: "phoenix_crm_plan_day_starts", by: "parent", where: `plan_id in (${TEST_PLANS})` },
  {
    // `request_id`, not `plan_edit_request_id`.
    table: "phoenix_crm_plan_edit_request_events",
    by: "parent",
    where: `request_id in (select id from phoenix_crm_plan_edit_requests where is_test or plan_id in (${TEST_PLANS}))`,
  },
  { table: "phoenix_crm_plan_edit_requests", by: "flag", where: `is_test or plan_id in (${TEST_PLANS})` },
  {
    table: "phoenix_crm_monthly_plan_events",
    by: "parent",
    where: "monthly_plan_id in (select id from phoenix_crm_monthly_plans where is_test)",
  },
  { table: "phoenix_crm_monthly_plans", by: "flag", where: "is_test" },
  {
    // Its `visit_id` matches the parent's `visit_id` column, a uuid. `id` there is a bigint.
    table: "phoenix_crm_unplanned_visit_events",
    by: "parent",
    where:
      "visit_id in (select visit_id from phoenix_crm_unplanned_visits" +
      ` where is_test or customer_id in (${TEST_CUSTOMERS}) or visit_id in (${TEST_VISITS}))`,
  },
  {
    table: "phoenix_crm_unplanned_visits",
    by: "flag",
    where: `is_test or customer_id in (${TEST_CUSTOMERS}) or visit_id in (${TEST_VISITS})`,
  },
  { table: "phoenix_crm_plans", by: "flag", where: "is_test" },

  // The district manager's weekly plan. Its ticked customers and his own visits reference
  // phoenix_crm_customers with no cascade, so they go before the spine; the header's other children
  // cascade, and are named anyway so the proof reads every table.
  {
    table: "phoenix_crm_manager_plan_customers",
    by: "parent",
    where:
      `slot_id in (${TEST_MANAGER_SLOTS}) or customer_id in (${TEST_CUSTOMERS})` +
      ` or manager_customer_id in (${TEST_MANAGER_CUSTOMERS})`,
  },
  {
    table: "phoenix_crm_manager_visits",
    by: "flag",
    where: `is_test or customer_id in (${TEST_CUSTOMERS}) or manager_customer_id in (${TEST_MANAGER_CUSTOMERS})`,
  },
  { table: "phoenix_crm_manager_plan_slots", by: "parent", where: `plan_id in (${TEST_MANAGER_PLANS})` },
  { table: "phoenix_crm_manager_plan_events", by: "parent", where: `plan_id in (${TEST_MANAGER_PLANS})` },
  { table: "phoenix_crm_manager_plan_edit_requests", by: "flag", where: `is_test or plan_id in (${TEST_MANAGER_PLANS})` },
  { table: "phoenix_crm_manager_plans", by: "flag", where: "is_test" },
  { table: "phoenix_crm_manager_customers", by: "flag", where: "is_test" },

  // Everything hanging off a customer, a place or a visit.
  { table: "phoenix_crm_customer_moves", by: "flag", where: `is_test or customer_id in (${TEST_CUSTOMERS})` },
  {
    table: "phoenix_crm_validation_reviews",
    by: "flag",
    where: `is_test or customer_id in (${TEST_CUSTOMERS}) or place_id in (${TEST_PLACES})`,
  },
  {
    table: "phoenix_crm_visit_asks",
    by: "flag",
    where: `is_test or customer_id in (${TEST_CUSTOMERS}) or visit_id in (${TEST_VISITS})`,
  },
  { table: "phoenix_crm_visit_edits", by: "flag", where: `is_test or visit_id in (${TEST_VISITS})` },
  {
    table: "phoenix_crm_removed_visits",
    by: "flag",
    where: `is_test or visit_id in (${TEST_VISITS}) or customer_id in (${TEST_CUSTOMERS})`,
  },
  { table: "phoenix_crm_location_integrity", by: "flag", where: "is_test" },
  { table: "phoenix_crm_behaviour_integrity", by: "flag", where: "is_test" },
  { table: "phoenix_crm_photo_fingerprints", by: "flag", where: "is_test" },
  { table: "phoenix_crm_refused_readings", by: "flag", where: `is_test or customer_id in (${TEST_CUSTOMERS})` },
  {
    table: "phoenix_crm_list_events",
    by: "flag",
    where: `is_test or customer_id in (${TEST_CUSTOMERS}) or place_id in (${TEST_PLACES})`,
  },
  { table: "phoenix_crm_list_requests", by: "flag", where: `is_test or customer_id in (${TEST_CUSTOMERS})` },

  // The spine, parents last. A chained visit goes with its parent: `linked_from_visit_id` cascades.
  {
    table: "phoenix_crm_visits",
    by: "flag",
    where: `is_test or customer_id in (${TEST_CUSTOMERS}) or place_id in (${TEST_PLACES})`,
  },
  { table: "phoenix_crm_places", by: "flag", where: `is_test or customer_id in (${TEST_CUSTOMERS})` },
  { table: "phoenix_crm_shared_places", by: "flag", where: "is_test" },
  { table: "phoenix_crm_customers", by: "flag", where: "is_test" },

  // Free-standing: nothing references these, so they go last and in any order.
  { table: "phoenix_crm_touch_trail", by: "flag", where: "is_test" },
  { table: "phoenix_crm_photo_uploads", by: "flag", where: "is_test" },
  { table: "phoenix_crm_voice_uploads", by: "flag", where: "is_test" },
  { table: "phoenix_crm_visit_recordings", by: "flag", where: "is_test" },
  { table: "phoenix_crm_day_starts", by: "flag", where: "is_test" },
  { table: "phoenix_crm_day_activities", by: "flag", where: "is_test" },
  { table: "phoenix_crm_daily_forecasts", by: "flag", where: "is_test" },
  { table: "phoenix_crm_time_anchors", by: "flag", where: "is_test" },
  { table: "phoenix_crm_double_visit_plans", by: "flag", where: "is_test" },
];

/**
 * Every way the plan can be wrong about the schema, in plain words. Empty means it is safe to run.
 *
 * A foreign key only matters when the plan clears its PARENT: then the child's rows must already be
 * gone, or the delete fails. A self reference is fine — both rows go in one statement — and so is a
 * key the database resolves itself: `cascade`, `set null`, `set default`.
 */
export function planProblems(edges: readonly FkEdge[], plan: readonly Step[]): string[] {
  const positionOf = new Map<string, number>();
  plan.forEach((step, index) => positionOf.set(step.table, index));
  const problems: string[] = [];
  for (const edge of edges) {
    const parentAt = positionOf.get(edge.parent);
    if (parentAt === undefined) continue;
    if (edge.child === edge.parent) continue;
    if (edge.onDelete === "c" || edge.onDelete === "n" || edge.onDelete === "d") continue;
    const childAt = positionOf.get(edge.child);
    if (childAt === undefined) {
      problems.push(`${edge.child} references ${edge.parent}, which this clears, and the plan never clears it`);
      continue;
    }
    if (childAt > parentAt) {
      problems.push(`${edge.child} is cleared AFTER ${edge.parent}, which it references`);
    }
  }
  return problems;
}

/** `--name` / `--name=value`, with an unknown flag refused rather than ignored. */
export function parseFlags(argv: readonly string[]): { label: string } {
  const known = new Set(["label"]);
  const values = new Map<string, string>();
  for (const entry of argv) {
    if (!entry.startsWith("--")) throw new Error(`Unknown argument ${entry} — refused rather than ignored.`);
    const name = entry.slice(2).split("=")[0];
    if (!known.has(name)) throw new Error(`Unknown flag --${name} — refused rather than ignored.`);
    values.set(name, entry.includes("=") ? entry.slice(entry.indexOf("=") + 1) : "true");
  }
  return { label: values.get("label") ?? "" };
}

const quoted = (tables: readonly string[]): string => tables.map((table) => `'${table}'`).join(", ");
const shortName = (table: string): string => table.replace("phoenix_crm_", "");

/**
 * The whole .sql file: two guards, the deletes, a third guard that rolls the lot back unless every
 * re-count reads zero, then the proof query. One transaction, so a stale plan changes nothing.
 */
export function buildSql(plan: readonly Step[] = DELETE_PLAN, label = ""): string {
  const covered = plan.map((step) => step.table);
  const lines: string[] = [
    "-- Clear every Phoenix CRM TEST row.",
    "-- Generated by scripts/phoenix-crm-clear-test-rows.ts — edit the plan there, never this file.",
  ];
  if (label) lines.push(`-- ${label}`);
  lines.push(
    "--",
    "-- Apply:  node scripts/apply-sql-file.mjs <this file> <staging|production>",
    "-- On production this is a BULK DESTRUCTIVE change and there is NO point-in-time recovery:",
    "-- seven daily backups are the whole recovery story. Announce it in plain words first.",
    "--",
    "-- The test-persona accounts are NOT touched. Their worlds go empty; they keep working.",
    "",
    "begin;",
    "",
    `-- GUARD 1. ${COUNTABLE_VISITS_VIEW} must still be a VIEW over the visits. It carries its own`,
    "-- is_test column, so if it is ever materialised its rows would survive this sweep unseen.",
    "do $$",
    'declare kind "char";',
    "begin",
    "  select c.relkind into kind from pg_class c",
    "    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'",
    `    where c.relname = '${COUNTABLE_VISITS_VIEW}';`,
    "  if kind is not null and kind <> 'v' then",
    `    raise exception '${COUNTABLE_VISITS_VIEW} is no longer a view (relkind %) — add it to the plan before the visits step.', kind;`,
    "  end if;",
    "end $$;",
    "",
    "-- GUARD 2. No CRM table may reference a parent this clears without being cleared first. A child",
    "-- table added after this file was generated aborts the run WITH ITS NAME, rather than failing",
    "-- halfway through on a foreign key nobody can place.",
    "do $$",
    "declare stale text;",
    "begin",
    "  select string_agg(format('%s references %s', con.conrelid::regclass, con.confrelid::regclass), '; ')",
    "    into stale",
    "    from pg_constraint con",
    "    join pg_class pc on pc.oid = con.confrelid",
    "    join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = 'public'",
    "   where con.contype = 'f'",
    "     and con.conrelid <> con.confrelid",
    "     and con.confdeltype not in ('c', 'n', 'd')",
    `     and con.confrelid::regclass::text in (${quoted(covered)})`,
    `     and con.conrelid::regclass::text not in (${quoted(covered)});`,
    "  if stale is not null then",
    "    raise exception 'The delete plan is stale: % — add the table to the plan and regenerate.', stale;",
    "  end if;",
    "end $$;",
    "",
    "-- The sweep, child-first.",
  );
  for (const step of plan) {
    if (step.by === "parent") lines.push("-- no is_test column of its own: reached through its parent");
    lines.push(`delete from ${step.table} where ${step.where};`);
  }
  lines.push(
    "",
    "-- GUARD 3. Nothing may be left, including through the view. Any leftover rolls back the lot.",
    "do $$",
    "declare left_over text := '';",
    "declare n bigint;",
    "begin",
  );
  for (const step of plan) {
    lines.push(`  select count(*) into n from ${step.table} where ${step.where};`);
    lines.push(`  if n > 0 then left_over := left_over || ' ${step.table}=' || n; end if;`);
  }
  lines.push(
    `  select count(*) into n from ${COUNTABLE_VISITS_VIEW} where is_test;`,
    `  if n > 0 then left_over := left_over || ' ${COUNTABLE_VISITS_VIEW}(view)=' || n; end if;`,
    "  if left_over <> '' then",
    "    raise exception 'Rolled back — the sweep did not finish:%', left_over;",
    "  end if;",
    "end $$;",
    "",
    "commit;",
    "",
    "-- Proof. Every number must read 0.",
  );
  const proof = plan
    .map((step) => `select '${shortName(step.table)}' as t, count(*) as n from ${step.table} where ${step.where}`)
    .concat([
      `select '${shortName(COUNTABLE_VISITS_VIEW)} (view)' as t, count(*) as n from ${COUNTABLE_VISITS_VIEW} where is_test`,
    ]);
  lines.push(`${proof.join("\nunion all ")}\norder by n desc, t;`, "");
  return lines.join("\n");
}

const invokedDirectly = process.argv[1]
  ? process.argv[1].replace(/\\/g, "/").endsWith("scripts/phoenix-crm-clear-test-rows.ts")
  : false;
if (invokedDirectly) {
  try {
    const flags = parseFlags(process.argv.slice(2));
    process.stdout.write(buildSql(DELETE_PLAN, flags.label));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
