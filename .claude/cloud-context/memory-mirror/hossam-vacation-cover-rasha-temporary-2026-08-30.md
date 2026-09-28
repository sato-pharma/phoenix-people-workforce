---
name: hossam-vacation-cover-rasha-temporary-2026-08-30
description: "CLOSED 2026-09-07 — the Hossam vacation cover is FULLY REVERTED on production at the owner's instruction and is NO LONGER IN EFFECT. Marketing review reads Marketing Manager on Anti Infective + CNS again, Pedia stays Group Product Manager BY DESIGN (never part of the cover), and both reroute triggers plus phx_cover_reroute_hossam_plans() are dropped. Kept as the record of what the cover was, how it was undone, and where both pre-images live. Do not re-apply it, and do not read Pedia's GPM row as leftover cover."
metadata:
  node_type: memory
  type: project
  originSessionId: b84fcd22-a5f7-4a12-88e9-8bc7506440bf
  modified: 2026-09-26T01:11:51.884Z
---

## Current state — REVERTED IN FULL (2026-09-07). Do not re-apply.

The cover (Rasha Sabry, `A-8`, Group Product Manager, covering Hossam Mohamed Reda, `A-9`, Marketing
Manager, on open-ended annual leave from 2026-08-30) was undone on production at the owner's instruction:
`marketing_review_routing` lines 1 (Anti Infective) + 3 (CNS) back to **Marketing Manager**, open steps
and rerouted plan headers repointed back to A-9, and both `employee_plan_headers_cover_reroute_*` triggers
plus `phx_cover_reroute_hossam_plans()` dropped.

🔴 **PEDIA (line 2) reads `Group Product Manager` AND ALWAYS DID — it was NEVER part of the cover.** After
the revert, two routing rows say Marketing Manager and one says GPM, which LOOKS like a half-finished job
and is not: **line 2 is Rasha's own line by design. Do not "finish" it.** Same trap on the steps and plans:
anyone who reports to A-8 (e.g. `B-155`) had their work correctly decided by A-8 — that is her own line,
not leftover cover activity.

**Both pre-images are kept:** `hossam_cover_backup_20260830.pre_image` (state before the cover) and
`hossam_revert_backup_20260907` (`pre_image` + `dropped_objects`, the full `pg_get_triggerdef` /
`pg_get_functiondef` text of the three dropped objects — so the cover can be recreated verbatim for the
next vacation). Both the install and the revert went in as **fileless operational migrations with no repo
file** (deliberate — a repo file would recreate a temporary object on any staging rebuild), so **expect
them as drift.**

## Durable lesson — the "Decided for you" tab (`decided-for-me.ts`)

The cover exposed a real gap: an approval history is scoped to what YOU decided, so a coverer's decisions
were invisible to the manager they were taken for. The fix is the **"Decided for you"** tab on the
Approvals Hub (`src/lib/action-center/decided-for-me.ts`, pinned by `tests/decided-for-me.test.ts` in the
required `validate` job). It shows the decider's own words in full (owner: *"show what she wrote"*), is
hidden when empty, and both pages swallow its failure rather than take the hub down.

- 🔴 **VERIFY A READ-ONLY LIST BY RUNNING IT AS THE REAL VIEWER.** The first two versions shipped green,
  typechecked and tested and were WRONG — `getDecisionsMadeForMe` returned 38 rows where 8 were real
  (rows with no decider, legacy leave imports, admin corrections), and on a second run returned **ZERO**
  because a transient `getEmployeeDirectory()` failure was swallowed into `[]`. CI cannot see any of that;
  only running it against production with the subject's own AccessContext can.
- **Two ownership rules, both load-bearing:** `team` (the employee reports to you: leave, excuse, weekly
  plan) and `line` (the request sits on a line you review: marketing, resolved live from
  `marketing_review_routing`). A marketing request is normally raised by a rep who does NOT report to the
  reviewer, so a team-only rule misses most of them.

## Durable mechanics — for building or reverting the NEXT cover

- 🔴 **A `marketing_review_routing` role flip alone is NOT enough — the managerial-chain rebound.** Once
  the reviewer role stops being `Marketing Manager`, `buildMarketingManagerChain` no longer breaks at the
  covered manager, so a requester who **reports to him** gets him re-inserted as their *line manager* rung
  instead. Sales-side requesters are unaffected (their walk stops at Regional Manager / NSM). So in-flight
  steps must be repointed **by hand**, not left to the routing.
- **A plan's approver is stamped from `employees.manager_hr_id` at creation** (`service.ts`), and a
  resubmitted returned plan keeps its stored one — so a routing flip silently stops covering weekly plans
  after the first week. That is why the cover needed the reroute **DB trigger** (`WHEN manager_hr_id =
  '<covered>'` lowered, so no other employee's plan enters it). **Weekly plans have NO self-approval
  guard**, so the coverer's OWN plan must be routed to the CEO, never to herself.
- 🔴 **NEVER fix a cover by editing `employees.manager_hr_id`** — that is the org skeleton
  ([[never-change-the-organogram-skeleton]]) and it ripples into the organogram and CRM attribution. Route
  around it (routing rows + reroute trigger), leave already-decided steps alone.
- **To tell whether a manager is actually working, check the decision columns on the request tables**
  (e.g. `v2_excuse_requests.manager_decision_by_hr_id`), **not just `audit_logs`** — excuse decisions do
  not land in `audit_logs`, so an audit-log-only check reads a working manager as silent.

Related: [[marketing-decision-gate-is-identity-not-role]].
