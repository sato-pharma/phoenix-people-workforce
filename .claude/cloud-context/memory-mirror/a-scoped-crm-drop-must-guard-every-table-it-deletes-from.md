---
name: a-scoped-crm-drop-must-guard-every-table-it-deletes-from
description: "scripts/phoenix-crm-clear-test-rows.ts clears is_test rows ONLY, so training rows made by real seats need their own scoped file — and its stale-plan guard must name EVERY table it deletes from, not just the spine, or a grandchild two steps down aborts the run."
metadata:
  node_type: memory
  type: project
  originSessionId: d599b183-92d8-4906-8474-b8c852e03285
  modified: 2026-10-15T17:02:19.373Z
---

`scripts/phoenix-crm-clear-test-rows.ts` selects on `is_test`. **Rows a REAL rep seat produced during
a training session carry `is_test = false`, so that script cannot reach them** — and flagging them
first would also sweep the 835 test-persona customers the same run, a far wider blast radius than
asked for. A training-day drop therefore needs its own scoped .sql file.

**Its guard 2 must list every table the file deletes from as a possible parent, not only the spine.**
Copying the generator's guard with the five spine tables (`places`, `customers`, `shared_places`,
`visits`, `crm_contacts`) passed, and the run then died mid-transaction on
`phoenix_crm_unplanned_visit_events`, a grandchild two steps down — the whole thing rolled back, 0
rows changed. The two that bite:

- `phoenix_crm_unplanned_visit_events.visit_id` → `phoenix_crm_unplanned_visits.visit_id`, a **uuid**
  matching the parent's `visit_id`, never its bigint `id`. Resolve the id set into a temp table
  BEFORE deleting the parent, or the set is gone when you need it.
- `crm_contact_list_change_events.change_id` → `crm_contact_list_changes.id`, under **RESTRICT**.

Write the guard as one `plan text[]` used for both halves — `confrelid = any(plan)` and
`not (conrelid = any(plan))` — so the parent list and the covered list can never drift apart.
`phoenix_crm_place_notes` and `phoenix_crm_place_recommendations` cascade and need no entry.
`phoenix_crm_list_events` has **no foreign key at all**, so a deleted customer leaves orphans there
silently: production already holds 229 from older deletions. See
[[a-training-day-row-is-judged-by-when-its-customer-was-created]].
