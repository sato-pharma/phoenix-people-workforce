---
name: removing-crm-test-rows-needs-parent-id-deletes
description: A `where is_test` sweep of the CRM cannot clear it — seven child tables carry no such column and must be deleted by parent id, and `phoenix_crm_countable_visits` is a VIEW that a row inventory double-counts and a delete errors on.
metadata:
  type: project
---

**Use `scripts/phoenix-crm-clear-test-rows.ts`** (PR 5716) — it prints the SQL for `scripts/apply-sql-file.mjs`, and the emitted file asks `pg_constraint` itself whether the plan still covers every child before it deletes anything. Clearing the CRM's test rows on production (`ozucdzovmcqvepbozvqf`) is **6,355 physical rows across 19 tables**, not the 16 a flag sweep finds, and a flag-only delete fails on a foreign key.

- **Seven CRM child tables have no `is_test` column** and must be deleted by parent id: `phoenix_crm_plan_items` (316 rows, reachable through `plan_id`, `customer_id` *and* `place_id`), `plan_events` (45), `plan_edit_request_events` (6, its column is **`request_id`**, not `plan_edit_request_id`), `plan_activities`, `plan_day_starts`, `monthly_plan_events`, and `unplanned_visit_events` (its **`visit_id` is a uuid matching `phoenix_crm_unplanned_visits.visit_id`, not that table's bigint `id`** — joining on `id` answers `operator does not exist: uuid = bigint`).
- 🔴 **`phoenix_crm_countable_visits` is a VIEW over `phoenix_crm_visits`** (`relkind = 'v'`), and it has an `is_test` column, so a `pg_class`-wide count of test rows silently counts its 13 rows twice and a delete against it errors. Its rows clear themselves when the 14 test visits go.
- **Every foreign key into a CRM parent comes from another CRM table** — nothing outside the module points at a CRM row, so the delete order is self-contained. All are `NO ACTION` except `phoenix_crm_customer_moves.customer_id` (`RESTRICT`) and `phoenix_crm_visits.linked_from_visit_id` → `visits` (`CASCADE`, which handles a chained visit on its own).
- Order that works, child-first: plan_items → plan_events/activities/day_starts → plan_edit_request_events → plan_edit_requests → monthly_plan_events → monthly_plans → unplanned_visit_events → unplanned_visits → plans → customer_moves/validation_reviews/visit_asks/visit_edits/removed_visits/location_integrity/behaviour_integrity/photo_fingerprints/refused_readings → list_events → list_requests → visits → places → shared_places → customers → touch_trail/photo_uploads/voice_uploads/day_starts/day_activities/daily_forecasts/time_anchors/double_visit_plans.
- The test rows exist because of his own test-persona feature, so clearing them empties the ten `is_test_persona` accounts' worlds and leaves the accounts themselves working — see [[test-crm-rows-on-production-are-his-own-persona-feature]].
