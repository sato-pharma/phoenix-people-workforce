---
name: check-constraint-drop-recreate-collides-across-branches
description: "Two parallel migrations that each drop+recreate the same CHECK constraint from an independently-hardcoded key list can collide — the second-applied one silently omits whatever key the other branch added, unless someone manually reconciles the lists before merging."
metadata: 
  node_type: memory
  type: project
  originSessionId: a5c2af36-5086-41d3-8dc4-af6567b8991e
  modified: 2026-08-09T21:56:04.066Z
---

`notification_role_policies_notification_key_check` was rebuilt independently by two parallel
migrations: `20260809230000_payroll_workflow_alert_role_policy.sql` (adds `payroll_workflow_alert`,
merged as PR #1982) and `20260810000000_notification_role_policies_resignation_and_import_alert_keys.sql`
(adds `resignation_workflow_alert` + `employee_import_alert`, merged as PR #1981). Each does a full
`drop constraint` + `add constraint check (notification_key in (...))` with its own hardcoded list
instead of widening the existing one additively — so each migration's list reflects only the keys
its own author knew about at draft time.

PR #1982 exists **because** an earlier draft of the payroll migration hit exactly this: the
constraint didn't yet allow `payroll_workflow_alert` when the migration tried to seed its row.
`20260810000000` avoided repeating the mistake only because whoever finalized it (before merging
PR #1981, which landed after #1982) noticed the payroll migration had already landed and manually
folded `payroll_workflow_alert` into its own rebuilt list — see the code comment at the top of that
file, which says so explicitly. That save was manual, not structural: nothing stops the next
parallel branch touching this constraint from repeating the mistake with a stale list, and a
2026-08-10 investigation into this exact pair (prompted by a handoff describing the bug as still
live) found the code already fixed — the handoff itself was stale by the time it was acted on.

**Why:** migration timestamps decide apply order, and `ADD CONSTRAINT` validates existing rows — so
if the earlier-timestamped migration's seed row isn't in the later migration's hardcoded list, the
later one fails outright the moment it runs. Verified live 2026-08-10: applying this exact pair in
timestamp order (payroll migration, then the resignation/import-alert one) is safe end-to-end
because the later one already carries the earlier one's key forward; applying them out of order
would not be, since the earlier migration's narrower list would then reject rows the later one had
already seeded. Related but distinct from [[migration-timestamp-collides-across-parallel-branches]]
— that one is a filename-timestamp collision; this is a semantic/content collision on a shared
constraint, and passes CI either way since nothing checks cross-migration constraint consistency.

**How to apply:** whenever a migration rebuilds a shared CHECK constraint with `drop constraint` +
hardcoded `add constraint ... in (...)`, check `git log --all` / open PRs for other in-flight
migrations touching the same constraint before finalizing the list, and read the *live*
`pg_get_constraintdef` immediately before drafting the new one rather than assuming the last-seen
version. Suggest widening additively where practical instead of a wholesale hardcoded replace — it
would have made this whole class of collision impossible.
