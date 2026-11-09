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

## Who decides a test entry: the Super Admin, from his "Test accounts" tab (2026-10-22)

The owner, 2026-10-22: *"In Phoenix CRM, in admin account, add a new tab called Test accounts. It will
be responsible for all approvals that I do with test accounts … anything that needs approval in Phoenix
CRM, I can submit it in the test account and approve in my own admin account."* Asked three questions
the same day, he picked:

- **Step by step.** He takes the step a test entry is AT — the district, regional or national manager's,
  then SFE's, or the first then the second approver of a manager's week — and a two-step entry comes
  back to the tab at its next step. The test rep reads every in-between state a real rep would.
- **Only his tab.** A test district, regional or national manager login no longer decides a test
  entry's manager step. A double-visit request and a visit ask stay answerable by the test person they
  are addressed to — those are not approvals.
- **Real rows unchanged.** `superAdminDoesNotDecide()` still refuses every real decision of his.

How it is built (`src/lib/phoenix-crm/server/test-approvals.ts`):

- `decidesTestWorld(viewer)` is the Super Admin signed in as himself with a deciding grant;
  `assertTestWorldDecider()` is the gate every test-row decision answers to (`assertReviewer`, the
  off-plan, edit-request and list-request gates, and `managerPlanDeciderRole`). A test login reads
  "Test entries are decided by the Super Admin, from his own … tab".
- The list is read with the module's own loaders, pinned to the test world: the Team tab's row loaders
  and rights for list requests, off-plan visits and requests to edit a week; `loadPlanReviews` and
  `loadMonthlyPlanReviews` asked for the test world by name (`worldFor(…, { testWorld: true })`); the
  Place checks board's waiting test rows; and the Approvals Hub's four reads for the managers' weeks,
  asks to edit, own-list removals and single-visit days (`loadOpenManagerPlanItems`).
- Every decision goes through the decider the real screens call, after the route reads the row's own
  `is_test` and refuses a real row by name. A test row's notice reaches `TEST-` logins only, in-app only.
- Left out on purpose: the double/chain visit invitations and visit asks (their addressee answers), a
  recorded visit's Administrator step (the Visit Recording page) and a held polyclinic (Shared places).
- The tab's badge counts the plans, list requests, requests to edit and off-plan visits the overview
  already counts for him; the monthly plans, place checks and managers' items show in the list but not
  in the badge.

## A test account reads the real field force (2026-11-09)

The owner, signed in as Hany Saad's test account, found every Phoenix CRM report empty: each read was
forced into the test world, which holds next to nothing. Asked what a test account should read, he
picked **"Real data everywhere"**, a test rep's own visit and plan screens included.

- **Reads** go through `readWorldFor(viewer, flag, read?)` (cross-territory loaders) and
  `territoryForView(viewer, seatId, flag)` (one territory). Both answer the real world for everybody;
  only the Super Admin's "Test accounts" tab can still ask for the test world (`{ testWorld: true }`).
- **Saves and decisions** keep `testModeFor`, `worldFor` and `territoryForRead`, which still put a test
  account in the test world. `territoryForRead` is deliberately left that way: SFE's drop, bring-back
  and move, and the place moves, go through it before they write.
- So a test rep's own new saves sit apart from what he reads. A real row carries no edit control for him
  (`canWriteAsRep` answers false for a test account on a real row), the inboxes read with
  `canAnswer: false` / `canWrite: false`, and `managerPlanDeciderRole` gives him no step on a real week.
  The approvals detail opens a real record read only (`opensWorld`, `manager-plan-hub.ts`), and a real
  visit's recording plays.
- The entry forms stay in the test world: Add Visit (`territoryForVisit`), the forecast form and the
  copy-a-week source.
- A test account's read of a real territory **mints nothing** (`ensureReferenceCustomersForView`); the
  territory's own people mint on their next open.
- Pinned by `tests/phoenix-crm-admin-surface.test.ts` (section 2).
