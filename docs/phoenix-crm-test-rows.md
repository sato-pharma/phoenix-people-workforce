# The CRM test rows — what they are, and what clearing them actually costs

The account behind the module hook in `.claude/rules/phoenix-crm.md`: *"the test rows are cleared by
`scripts/phoenix-crm-clear-test-rows.ts`, never by a hand-written `where is_test`"*. The hook is the
cue; this file is the evidence, so it is not re-sent on every request.

## They are a feature, not a leak

Ten `app_auth_users` rows carry `is_test_persona`, by the owner's own design of **2026-09-27**: each
one mirrors a real employee so he can walk the CRM as that person without touching their account. A
persona's session resolves to the **mirrored person's `hrId`**, so a visit a persona files writes a
real id — `B-158`, for instance — into `entered_by_hr_id`.

Two consequences, both of which have misled a session before:

- **Never "fix" test writes on production.** A test visit is the feature working.
- **Never read `entered_by_hr_id` as proof a real rep filed a row.** It reads real by construction.

Clearing the test rows empties the personas' worlds. It does **not** touch the ten accounts: they
stay active and usable afterwards, which is the point of clearing rather than deleting.

## The inventory is 6,355 rows across 19 tables — and a flag sweep gets it wrong three ways

Read live against production (`ozucdzovmcqvepbozvqf`) on **2026-10-09**. A sweep that simply looks
for an `is_test` column answers "about 6,000 rows in 16 tables", and each of the three differences
is a real failure:

1. **`phoenix_crm_countable_visits` is a VIEW, not a table** (`pg_class.relkind = 'v'`), and it
   carries its own `is_test` column. A `pg_class` inventory therefore counts its **13** rows a second
   time, and a `delete from` against it errors outright. Its rows clear themselves when the
   underlying visits go, so the sweep never deletes from it — it only **proves** it empty.
2. **Seven child tables carry no `is_test` column at all** and must be reached through a parent:
   `plan_items` (**316** rows), `plan_events` (45), `plan_edit_request_events` (6),
   `plan_activities`, `plan_day_starts`, `monthly_plan_events`, `unplanned_visit_events` (1).
   The district manager's weekly plan (migration `20261017000000`) added three more —
   `manager_plan_slots`, `manager_plan_customers` and `manager_plan_events`, all reached through
   `phoenix_crm_manager_plans` — so the list is ten.
3. **Two of those are spelled unexpectedly**, and each spelling cost a real error against production
   while the first statement was being written by hand:
   - `column "plan_edit_request_id" does not exist` — `phoenix_crm_plan_edit_request_events` is keyed
     on **`request_id`**.
   - `operator does not exist: uuid = bigint` — `phoenix_crm_unplanned_visit_events.visit_id` is a
     uuid matching the parent's **`visit_id`**, not that table's own bigint `id`.

`phoenix_crm_plan_items` hangs off **three** parents — `plan_id`, `customer_id` and `place_id` — so
filtering it on the plan alone leaves rows behind.

## The foreign-key graph: 22 edges, every one of them inside the module

`pg_constraint`, read the same day: 22 foreign keys reference a CRM parent, and **not one comes from
outside the CRM**. That is why the sweep is self-contained and why nothing elsewhere in the platform
can be orphaned by it. All 22 are `NO ACTION` except two:

- `phoenix_crm_customer_moves.customer_id` — **RESTRICT**, so the moves must go before the customers.
- `phoenix_crm_visits.linked_from_visit_id` — **CASCADE**, which carries a chained visit away with
  its parent inside a single statement.

**The district manager's weekly plan added nine edges** (staging `pg_constraint`, 2026-10-17). Five
are inside his own tables and cascade or set null from the plan header and its slots. The four that
matter are `manager_plan_customers` and `manager_visits`, each referencing **both**
`phoenix_crm_customers` and `phoenix_crm_manager_customers` with `NO ACTION`. Both must therefore be
cleared before the spine, or Guard 2 aborts every sweep naming them.

## Why a script, and why it emits SQL instead of connecting

The order is the part that rots: one new CRM child table referencing a parent the plan clears makes a
hand-written sweep fail halfway through, with some tables already emptied. So the script holds the
plan, checks it, and prints one transaction:

- **It touches no database.** It writes SQL for the existing `scripts/apply-sql-file.mjs`, which owns
  the connection — no credential handling of its own.
- **Guard 1** re-asserts that `phoenix_crm_countable_visits` is still a view.
- **Guard 2** asks `pg_constraint` itself whether any table references a parent the plan clears
  without being cleared first, and aborts **naming that table**. Both guards run before the first
  delete, so a stale plan changes nothing.
- **Guard 3** is inside the transaction, after the deletes: unless every re-count — the view
  included — reads 0, the whole thing rolls back.
- Production has **no point-in-time recovery**; the emitted file says so in plain words.

`tests/phoenix-crm-clear-test-rows.test.ts` pins the plan against that live FK graph, and each of its
assertions was proven to fire by breaking the fix and restoring it.

## The run of 2026-10-09

The owner ran the generated statement himself and the proof query came back **0 for all 34 tables and
the view**. An independent read the same night: **10,946** real customers, **744** real visits, **11**
integrity cases present and unsettled, and the **10** test personas still active and untouched.
