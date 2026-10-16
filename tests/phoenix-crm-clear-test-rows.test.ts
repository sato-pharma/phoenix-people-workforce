// The CRM test-row sweep must stay correct about the schema it deletes from.
//
// WHY THIS EXISTS. Clearing the CRM's test rows looks like one `where is_test` and is not. Writing
// the first one by hand on 2026-10-09 produced three errors in a row against production, and all
// three are shapes a plan can drift back into:
//
//   1. `column "plan_edit_request_id" does not exist` — the child table is keyed on `request_id`.
//   2. `operator does not exist: uuid = bigint` — `phoenix_crm_unplanned_visit_events.visit_id` is a
//      uuid matching the PARENT's `visit_id`, not that table's own bigint `id`.
//   3. An inventory that counted 16 tables and 6,000 rows, because `phoenix_crm_countable_visits`
//      is a VIEW with its own `is_test` column: it was counted as a table, and a delete against it
//      would have errored. The real figure is 6,355 rows in 19 tables.
//
// The order is the part that rots. A new CRM child table referencing a parent the plan clears makes
// the sweep fail halfway through, so `planProblems` is the check and this file is what proves the
// check WORKS — not merely that today's plan passes it. KNOWN_EDGES is the foreign-key graph exactly
// as production (`ozucdzovmcqvepbozvqf`) answered `pg_constraint` on 2026-10-09: 22 edges, every one
// of them from one CRM table to another, which is why the sweep is self-contained. The district
// manager's weekly plan (20261017000000) added nine more, read from staging's `pg_constraint` on
// 2026-10-17 after the migration applied there.

import { strict as assert } from "node:assert";

import {
  buildSql,
  COUNTABLE_VISITS_VIEW,
  DELETE_PLAN,
  FLAGLESS_CHILDREN,
  parseFlags,
  planProblems,
  type FkEdge,
  type Step,
} from "../scripts/phoenix-crm-clear-test-rows.ts";

/**
 * Production's foreign keys into CRM parents, read live 2026-10-09. `onDelete` is `confdeltype`:
 * `a` = no action, `r` = restrict, `c` = cascade. Note the two that are not `a`, because they are
 * the two the plan treats specially: customer_moves RESTRICTS, and a visit's `linked_from_visit_id`
 * CASCADES, which is what carries a chained visit away with its parent.
 */
const KNOWN_EDGES: readonly FkEdge[] = [
  { child: "phoenix_crm_customer_moves", parent: "phoenix_crm_customers", onDelete: "r" },
  { child: "phoenix_crm_list_requests", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_places", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_plan_items", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_unplanned_visits", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_validation_reviews", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_visit_asks", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_visits", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_monthly_plan_events", parent: "phoenix_crm_monthly_plans", onDelete: "a" },
  { child: "phoenix_crm_plan_items", parent: "phoenix_crm_places", onDelete: "a" },
  { child: "phoenix_crm_validation_reviews", parent: "phoenix_crm_places", onDelete: "a" },
  { child: "phoenix_crm_visits", parent: "phoenix_crm_places", onDelete: "a" },
  { child: "phoenix_crm_plan_edit_request_events", parent: "phoenix_crm_plan_edit_requests", onDelete: "a" },
  { child: "phoenix_crm_plan_activities", parent: "phoenix_crm_plans", onDelete: "a" },
  { child: "phoenix_crm_plan_day_starts", parent: "phoenix_crm_plans", onDelete: "a" },
  { child: "phoenix_crm_plan_edit_requests", parent: "phoenix_crm_plans", onDelete: "a" },
  { child: "phoenix_crm_plan_events", parent: "phoenix_crm_plans", onDelete: "a" },
  { child: "phoenix_crm_plan_items", parent: "phoenix_crm_plans", onDelete: "a" },
  { child: "phoenix_crm_places", parent: "phoenix_crm_shared_places", onDelete: "a" },
  { child: "phoenix_crm_unplanned_visit_events", parent: "phoenix_crm_unplanned_visits", onDelete: "a" },
  { child: "phoenix_crm_unplanned_visits", parent: "phoenix_crm_visits", onDelete: "a" },
  { child: "phoenix_crm_visits", parent: "phoenix_crm_visits", onDelete: "c" },
  // The district manager's weekly plan. Two of its tables reference phoenix_crm_customers with no
  // cascade, so they must go before the spine; the header's own children cascade.
  { child: "phoenix_crm_manager_plan_customers", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_manager_visits", parent: "phoenix_crm_customers", onDelete: "a" },
  { child: "phoenix_crm_manager_plan_customers", parent: "phoenix_crm_manager_customers", onDelete: "a" },
  { child: "phoenix_crm_manager_visits", parent: "phoenix_crm_manager_customers", onDelete: "a" },
  { child: "phoenix_crm_manager_plan_customers", parent: "phoenix_crm_manager_plan_slots", onDelete: "c" },
  { child: "phoenix_crm_manager_visits", parent: "phoenix_crm_manager_plan_slots", onDelete: "n" },
  { child: "phoenix_crm_manager_plan_edit_requests", parent: "phoenix_crm_manager_plans", onDelete: "c" },
  { child: "phoenix_crm_manager_plan_events", parent: "phoenix_crm_manager_plans", onDelete: "c" },
  { child: "phoenix_crm_manager_plan_slots", parent: "phoenix_crm_manager_plans", onDelete: "c" },
];

const stepFor = (table: string): Step => {
  const step = DELETE_PLAN.find((entry) => entry.table === table);
  assert.ok(step, `${table} must be in the delete plan`);
  return step;
};

export async function runCrmClearTestRowsTests(): Promise<void> {
  // ── The plan is child-first for the schema as it actually is ──────────────────────────────────
  assert.deepEqual(
    planProblems(KNOWN_EDGES, DELETE_PLAN),
    [],
    "the plan must clear every child before the parent it references, for production's real foreign keys",
  );

  // ── and the check that proves that is not vacuous ─────────────────────────────────────────────
  // A CRM child table added next month, referencing a parent the plan clears and not cleared itself.
  const withNewChild: FkEdge[] = KNOWN_EDGES.concat([
    { child: "phoenix_crm_visit_sentiment", parent: "phoenix_crm_visits", onDelete: "a" },
  ]);
  const newChildProblems = planProblems(withNewChild, DELETE_PLAN);
  assert.equal(newChildProblems.length, 1, "a new child table referencing a cleared parent must be reported");
  assert.match(
    newChildProblems[0],
    /phoenix_crm_visit_sentiment references phoenix_crm_visits.*never clears it/,
    "the problem must NAME the table, so the operator knows what to add",
  );

  // A plan that clears a parent before its child is the same defect, found the same way.
  const customersFirst: Step[] = [stepFor("phoenix_crm_customers"), stepFor("phoenix_crm_places")];
  const orderProblems = planProblems(KNOWN_EDGES, customersFirst);
  assert.ok(
    orderProblems.some((problem) => /phoenix_crm_places is cleared AFTER phoenix_crm_customers/.test(problem)),
    "a parent cleared before its child must be reported, not silently accepted",
  );

  // A cascade needs no ordering: the database resolves it. A self reference goes in one statement.
  assert.deepEqual(
    planProblems(
      [
        { child: "phoenix_crm_visits", parent: "phoenix_crm_visits", onDelete: "c" },
        { child: "phoenix_crm_nothing_in_the_plan", parent: "phoenix_crm_customers", onDelete: "c" },
      ],
      DELETE_PLAN,
    ),
    [],
    "a cascade or a self reference is not a plan problem",
  );

  // A foreign key whose PARENT the plan never touches is none of this plan's business.
  assert.deepEqual(
    planProblems([{ child: "phoenix_crm_outside", parent: "phoenix_crm_settings", onDelete: "a" }], DELETE_PLAN),
    [],
    "a table the plan does not clear cannot make the plan stale",
  );

  // ── The view is a view: never deleted from, always proven empty ───────────────────────────────
  assert.equal(
    DELETE_PLAN.some((step) => step.table === COUNTABLE_VISITS_VIEW),
    false,
    `${COUNTABLE_VISITS_VIEW} is a VIEW over the visits — a delete against it errors, and its rows clear themselves`,
  );

  // ── The district manager's plan must be swept before the customers it references ─────────────
  // Without his ticked customers and his own visits in the plan, Guard 2 aborts every sweep the
  // moment the migration is live, because both reference phoenix_crm_customers with no cascade.
  const withoutManagerPlan = DELETE_PLAN.filter(
    (step) => step.table !== "phoenix_crm_manager_plan_customers" && step.table !== "phoenix_crm_manager_visits",
  );
  const managerProblems = planProblems(KNOWN_EDGES, withoutManagerPlan);
  for (const child of ["phoenix_crm_manager_plan_customers", "phoenix_crm_manager_visits"]) {
    assert.ok(
      managerProblems.some((problem) => problem.startsWith(`${child} references phoenix_crm_customers`)),
      `${child} references the customers this clears, so the plan must clear it first`,
    );
  }
  assert.ok(
    DELETE_PLAN.findIndex((step) => step.table === "phoenix_crm_manager_customers") <
      DELETE_PLAN.findIndex((step) => step.table === "phoenix_crm_customers"),
    "Manager's own list goes with the rest of his plan, before the spine",
  );

  // ── The ten tables with no is_test column of their own ────────────────────────────────────────
  for (const table of FLAGLESS_CHILDREN) {
    const step = stepFor(table);
    assert.equal(step.by, "parent", `${table} has no is_test column, so its rows must be reached through a parent`);
    assert.equal(
      /(^|\s)is_test(\s|$)/.test(step.where.split("(")[0]),
      false,
      `${table} must not be filtered on its own is_test column — it does not have one`,
    );
  }

  // The two column spellings that each cost an error against production.
  assert.match(
    stepFor("phoenix_crm_plan_edit_request_events").where,
    /^request_id in \(/,
    "plan_edit_request_events is keyed on request_id, not plan_edit_request_id",
  );
  assert.match(
    stepFor("phoenix_crm_unplanned_visit_events").where,
    /select visit_id from phoenix_crm_unplanned_visits/,
    "unplanned_visit_events.visit_id is a uuid matching the parent's visit_id — its id is a bigint",
  );
  // plan_items hangs off three different parents; filtering on only the plan leaves rows behind.
  const planItems = stepFor("phoenix_crm_plan_items").where;
  for (const column of ["plan_id", "customer_id", "place_id"]) {
    assert.ok(planItems.includes(`${column} in (`), `plan_items must be cleared by ${column} as well`);
  }

  // ── Flags are refused rather than ignored ─────────────────────────────────────────────────────
  assert.deepEqual(parseFlags([]), { label: "" }, "no flags is valid: the generator writes SQL to stdout");
  assert.deepEqual(parseFlags(["--label=September clean-up"]), { label: "September clean-up" });
  assert.throws(() => parseFlags(["--aply"]), /Unknown flag --aply/, "a misspelled flag must not be ignored");
  assert.throws(() => parseFlags(["production"]), /Unknown argument production/, "a bare word must not be ignored");

  // ── The emitted SQL ───────────────────────────────────────────────────────────────────────────
  const sql = buildSql();
  assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1, "the sweep must be ONE transaction");
  assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1, "the sweep must commit exactly once");

  const firstDelete = sql.indexOf("delete from");
  for (const guard of ["GUARD 1", "GUARD 2"]) {
    const at = sql.indexOf(guard);
    assert.ok(at > 0, `${guard} must be in the emitted file`);
    assert.ok(at < firstDelete, `${guard} must run BEFORE the first delete, so a stale plan changes nothing`);
  }
  assert.ok(sql.indexOf("GUARD 3") > firstDelete, "GUARD 3 proves the result, so it comes after the deletes");
  assert.ok(sql.indexOf("GUARD 3") < sql.indexOf("commit;"), "GUARD 3 must be inside the transaction to roll it back");
  assert.match(sql, /no point-in-time recovery/i, "the file must say in plain words that there is no PITR");

  for (const step of DELETE_PLAN) {
    assert.ok(
      sql.includes(`delete from ${step.table} where ${step.where};`),
      `${step.table} must appear as a delete in the emitted file`,
    );
  }
  assert.equal(
    sql.includes(`delete from ${COUNTABLE_VISITS_VIEW}`),
    false,
    "the emitted file must never delete from the view",
  );
  assert.ok(
    sql.includes(`select count(*) into n from ${COUNTABLE_VISITS_VIEW} where is_test;`),
    "the view must still be PROVEN empty, even though nothing deletes from it",
  );

  // Guard 2 asks the database about the plan's own table list, so the two must agree.
  for (const step of DELETE_PLAN) {
    assert.ok(sql.includes(`'${step.table}'`), `guard 2 must list ${step.table} among the tables it covers`);
  }

  // The proof query must cover every table and the view, or a leftover could go unreported.
  const proof = sql.slice(sql.indexOf("-- Proof."));
  assert.equal(
    (proof.match(/union all /g) ?? []).length,
    DELETE_PLAN.length,
    "the proof must read every table in the plan plus the view",
  );
  assert.match(proof, /order by n desc, t;$/m, "the proof must sort the worst number to the top");
}
