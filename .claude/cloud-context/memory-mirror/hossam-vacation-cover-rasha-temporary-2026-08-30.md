---
name: hossam-vacation-cover-rasha-temporary-2026-08-30
description: "CLOSED 2026-09-07 — the Hossam vacation cover is FULLY REVERTED on production at the owner's instruction and is NO LONGER IN EFFECT. Marketing review reads Marketing Manager on Anti Infective + CNS again, Pedia stays Group Product Manager BY DESIGN (never part of the cover), and both reroute triggers plus phx_cover_reroute_hossam_plans() are dropped. Kept as the record of what the cover was, how it was undone, and where both pre-images live. Do not re-apply it, and do not read Pedia's GPM row as leftover cover."
metadata: 
  node_type: memory
  type: project
  originSessionId: b84fcd22-a5f7-4a12-88e9-8bc7506440bf
  modified: 2026-09-07T12:28:37.981Z
---

## 2026-09-07 — REVERTED IN FULL. Everything below this section is history, not current state.

Owner: *"revert the hossam cover back to him"*, then *"hossam finished his vacation, everything
missed him should be able to know it"*. Applied to PRODUCTION 2026-09-07, verified after:

| Change | Result |
| --- | --- |
| `marketing_review_routing` lines 1 + 3 → `Marketing Manager` | 2 rows |
| 7 open `marketing_review` steps on lines 1/3 → `A-9` / `Marketing Manager` | 0 left with A-8 |
| 3 open `employee_plan_headers` → `manager_hr_id = A-9` | 0 still rerouted |
| `employee_plan_headers_cover_reroute_ins`/`_upd` + `phx_cover_reroute_hossam_plans()` | dropped, 0 left |

🔴 **PEDIA (line 2) READS `Group Product Manager` AND ALWAYS DID — it was NEVER part of the cover.**
After the revert two of the three routing rows say Marketing Manager and one says GPM, which looks
like a half-finished job and is not: line 2 is Rasha's own line by design. **Do not "finish" it.**
Same trap on the steps: 3 open Pedia `marketing_review` steps are still assigned to A-8, correctly,
and so are B-155's weekly plans — **B-155 reports to A-8, not to A-9**, so his plan decisions during
the cover window are her own work and must not be counted as cover activity.

**Two pre-images, keep both:** `hossam_cover_backup_20260830.pre_image` (6 rows, state before the
cover) and `hossam_revert_backup_20260907` — `pre_image` (13 rows: all 3 routing rows, the 7 steps,
the 3 plans) plus `dropped_objects` (the full `pg_get_triggerdef`/`pg_get_functiondef` text of all
three dropped objects, so the cover can be recreated verbatim for the next vacation).

**The DDL drop went in as migration `revert_vacation_cover_reroute_hossam_plans_to_rasha`, with no
repo file** — deliberately symmetric with how the cover was installed. Expect it as drift.

**That gap is now CLOSED IN THE APP — do not rebuild it, and do not hand out another XLSX.**
An approval history is scoped to what YOU decided, so a coverer's decisions were invisible to the
manager they were taken for. Shipped 2026-09-07 as the **"Decided for you"** tab on the Approvals
Hub (admin + portal): PR #3427 (`b17f416e4`), #3430 (`ece9779d4`), #3433 (`769d243ee`), all live.

🔴 **VERIFY A READ-ONLY LIST BY RUNNING IT AS THE REAL VIEWER — the first two PRs shipped green,
typechecked, tested, and were WRONG.** Run `getDecisionsMadeForMe` against production with the
subject's own AccessContext: it returned **38 rows where 8 were real** (9 with NO decider recorded,
13 legacy leave imports and admin corrections back to January), and on a second run it returned
**ZERO** — a transient `getEmployeeDirectory()` failure was being swallowed into `[]`. CI cannot
see any of that; only reading the actual output can. After #3433: **16 rows, 8 of them Rasha's.**
The remaining 8 are the CEO's own routine leave approvals, which pass the rule legitimately.
`src/lib/action-center/decided-for-me.ts`, pinned by `tests/decided-for-me.test.ts` in the required
`validate` job.

**Two ownership rules, and BOTH are load-bearing** — `team` (the employee reports to you: leave,
excuse, weekly plan) and `line` (the request sits on a line you review: marketing, resolved live
from `marketing_review_routing`). A marketing request is normally raised by a rep who does NOT
report to the reviewer, so a team-only rule misses most of them — it would have caught 1 of
Hossam's 4. The tab is hidden when empty, and both pages swallow its failure rather than take the
hub down. It shows the decider's own words in full, because the owner asked for exactly that
(*"show what she wrote"*) after the first version reported only the outcome and the timestamp.

## 2026-09-07 (earlier) — HE IS ACTING AGAIN. The "no live signal" claim below is now FALSE.

The 09-03 note says "'he's back' can only be learned from the owner, not from a query — there is
still no vacation record to watch." **There is now a query that answers it, and it says he is
working:** `v2_excuse_requests.manager_decision_by_hr_id = 'A-9'` carries three approvals made under
his own id — A-8 Rasha's (2026-09-06 10:16 Cairo), A-7 Ahmed's (2026-09-06 10:16), and A-10 Nahed's
(2026-09-07 10:54, **~1 minute** after it was submitted). The 09-03 check looked at `audit_logs`
alone, which is why it read as silence: **excuse decisions do not land there.** Check the decision
columns on the request tables, not just `audit_logs`, before concluding a manager is absent.

**Nothing has been reverted — the cover is still fully installed** (routing on lines 1/3 and both
`employee_plan_headers_cover_reroute_*` triggers). That is now a live inconsistency: he is deciding
excuses himself while his marketing-review and weekly-plan work is still being rerouted to A-8.
**Do not revert on this evidence alone** — deciding excuses from a phone is not the same as being
back at the desk, and the revert is a schema-touching change. Put it to the owner as a question.

## Re-verified 2026-09-03 against production

**Unchanged, still fully in effect.** `marketing_review_routing` still reads `Group Product Manager`
on all three lines (1, 2, 3). Both reroute triggers
(`employee_plan_headers_cover_reroute_ins`/`_upd`) are still installed on `employee_plan_headers`.
`A-9` (Hossam) is still `employment_status = active` (expected — leave doesn't flip that flag) and has
**zero `audit_logs` rows since 2026-08-30** — no sign of him resuming approvals under his own id. Since
nothing here auto-expires, "he's back" can only be learned from the owner, not from a query — there is
still no vacation record to watch. Nothing to do; not a candidate for periodic automated re-checking
the way the other four in-flight items are, since there's no live signal that changes on its own.

**Hossam Mohamed Reda AboElftouh (`A-9`, Marketing Manager) is on annual leave, open-ended, and
Rasha Sabry Sayed Khalifa (`A-8`, Group Product Manager) covers his approvals.** Owner instruction
2026-08-30. Phoenix has **no delegation feature** — nothing carries a date window, and there is no
vacation record for this trip in `v2_vacation_requests`, so **nothing will expire on its own.**

**What was changed in production (all reversible, pre-image in
`hossam_cover_backup_20260830.pre_image`, 6 rows):**

1. `marketing_review_routing` — lines **1 (Anti Infective)** and **3 (CNS)** `reviewer_role` moved
   `Marketing Manager` → `Group Product Manager`. Line 2 (Pedia) already reviewed at GPM.
   **All three lines now read `Group Product Manager` — that is the COVER, not the design.**
2. The two open `marketing_review` steps (`MKT-REQ-20260825-09BB51CA`, `-6B76BDCF`) repointed
   `assigned_hr_id` A-9 → A-8. Both were raised by A-10 Nahed, so no self-approval conflict.
3. `employee_plan_headers` — Ahmed Elkawas' (`A-7`) submitted plan reassigned to A-8; **Rasha's own
   submitted plan reassigned to the CEO (`AA`)**, because weekly plans have NO self-approval guard.

**Why the routing flip alone is not enough — the managerial-chain rebound.** `rolesGatedLater` in
`createMarketingApprovalSteps` is built from the dedicated later steps. Once the reviewer role stops
being `Marketing Manager`, the walk in `buildMarketingManagerChain` no longer breaks at A-9, so for a
requester who **reports to Hossam** (A-7 Ahmed, A-10 Nahed) he is re-inserted as their *line manager*
rung instead. Sales-side requesters are unaffected — their walk stops at Regional Manager / NSM. This
is why the two in-flight steps had to be repointed by hand rather than left to the routing.

4. **A DATABASE TRIGGER now reroutes new plans automatically** (migration
   `temp_vacation_cover_reroute_hossam_plans_to_rasha`, applied to PRODUCTION 2026-08-30; there is
   deliberately **no repo migration file** — it is a temporary operational object and a repo file
   would recreate it on any staging rebuild). `public.phx_cover_reroute_hossam_plans()` +
   `employee_plan_headers_cover_reroute_ins` / `_upd`. Needed because `service.ts:2741` stamps a new
   plan's approver straight from `employees.manager_hr_id`, and a resubmitted returned plan keeps its
   stored one (`:2822`) — so without it the cover silently stops working after the first week.
   The `WHEN` clause is `manager_hr_id = 'a-9'` lowered, so **no other employee's plan enters the
   function at all**. Rasha's own plan is sent to `AA`, never to herself. It writes its own
   `audit_logs` row per reroute (`actor_login_id = 'system'`).

**Proved 2026-08-30, all four cases, inside a rolled-back probe (zero residue):** Ahmed's new plan
→ A-8; Rasha's own → AA; an unrelated rep's plan on manager A-12 → **untouched**; the dormant W33
plan resubmitted → A-8. Four dormant returned plans still carry A-9 on purpose — they sit with the
employee, not with Hossam, and the `_upd` trigger catches them if anyone ever resubmits.

**How to apply — the revert, when he is back:** flip lines 1 and 3 back to `Marketing Manager`,
**drop both `employee_plan_headers_cover_reroute_*` triggers and
`public.phx_cover_reroute_hossam_plans()`** (nothing else depends on them), and leave every
already-decided step alone. Repoint any still-open step assigned to A-8 that belongs
to a line he owns. Weekly plans need nothing: the stamping already points at A-9.
**Never fix this by editing `employees.manager_hr_id`** for A-7 / A-10 — that is the org skeleton
(see [[never-change-the-organogram-skeleton]]) and it would ripple into the organogram and CRM
attribution. Related: [[marketing-decision-gate-is-identity-not-role]].
