---
name: approval-workflow-sweep-2026-08-19
description: "The complete inventory of Phoenix approval workflows as swept on 2026-08-19 — production has exactly THREE chain-shaped ones, and offer-approval config is wired to nothing."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 38cac8f5-eef9-4ca8-9b4c-3c23b0534074
  modified: 2026-08-19T12:40:00.000Z
---

Full sweep run 2026-08-19 after the vacation NSM bug, to find every other workflow that could
silently drop a required approver. Use this as the starting inventory instead of re-enumerating.

**Production has exactly THREE chain-shaped approval workflows** — confirmed by querying
`information_schema` for step tables, not by reading code:

| Table | Module | Verdict |
| --- | --- | --- |
| `v2_vacation_approval_steps` | Vacation | had the bug — fixed #2196 |
| `direct_order_approval_steps` | Direct orders | had a different bug — fixed #2198, see [[direct-order-chain-drops-the-whole-sales-line-silently]] |
| `marketing_request_approval_steps` | Marketing requests | clean |

**Marketing is clean and worth copying.** `buildMarketingManagerChain` walks real `manager_hr_id`
pointers, stops *after* the chain-target role (NSM) and *before* any manager whose role a later
dedicated step already gates (`rolesGatedLater`, the #2190 fix). It walks TWICE on purpose: the raw
walk answers "does this requester have any manager at all" (empty = hard error, throws), the gated
walk answers "which rungs are not already a formal later step" (empty = correct for marketing-side
requesters). Verified live: DMs B-116 and B-184 each carry a real "National Sales Manager Approval"
rung.

**Two-stage sign-offs that are NOT step tables** (found via columns, not table names — search for
`%approved_by%`/`%decision_by%` columns appearing more than once per table):
`weekly_plans` and `employee_plan_headers` carry `manager_decision_by_hr_id` + `ceo_decision_by_hr_id`.
Both stages are strictly gated (`assertManagerReviewer` / `assertCeoReviewer`); Super Admin cannot
stand in for either. The manager stage falls through to the CEO **only** when a plan genuinely has no
`manager_hr_id` (the NSM case) — documented, and it escalates upward rather than dropping anyone.

**Not chains at all:** outstation expenses (one HR decision + a system decision), excuses (single
step, and DM/RM are excluded from the module entirely), probation, resignation, contract renewal,
payroll batch.

🔴 **THE WHOLE OFFER & HIRING WORKFLOW IS FICTIONAL — and the owner decided 2026-08-19 to LEAVE IT
THAT WAY ("skip offers now"). Do not build it, and do not re-propose it.**

`workflow-control/definitions.ts` documents an `offer-hiring` workflow in full detail — `job_offers`,
`job_offer_audit_logs`, secure accept/reject tokens with expiry, candidate emails, employee creation,
vacancy fill. **None of it exists.** Verified in production 2026-08-19: `job_offers` = 0 tables,
`job_offer_audit_logs` = 0, and `table_name like '%offer%'` returns **zero rows of any kind**.

Everything around it is scaffolding with no floor:

- `src/config/offer-approval.ts` (`OFFER_APPROVAL_ALWAYS_ROLES`, `OFFER_CEO_APPROVAL_CAPS`,
  `resolvePositionApprovalThreshold`) has **zero call sites outside its own file**.
- Stages `offer_draft` / `offer_pending_approval` / `offer_approved` / `offer_generated` /
  `offer_negotiation` and the six `app_offer_*` action keys exist in `recruitment/types.ts` and get a
  colour in `recruitment-workspace.tsx`, but **none appear in `plainTransitionNextStatus`** in
  `recruitment/applications.ts` — so no code path can reach any of them.
- `ats_applications.offer_id` is a dangling column; `senior_approval_status` /`senior_approved_by` /
  `senior_approved_at` are **read** in `recruitment/db.ts` and **never written** anywhere.

Usable inputs if it is ever built: `ats_requisitions.salary_band_max` + `hiring_manager_hr_id` are
exactly what the threshold resolver wants. Active seats are singular — Super Admin = Omar Gawish,
Finance Manager = Ahmed El Maraghy, CEO = Anwar Gaweesh, Talent Acquisition = Youmna Kotb; **there is
no "HR Manager" role holder** despite the workflow doc naming one as the approver.

**Why this matters beyond recruitment:** the workflow-control page USED to present `offer-hiring` as
`status: "Active"`, `riskLevel: "High"`, so anyone reading it believed offers were governed.
**LABELLED HONESTLY 2026-08-19 in #2203 — LIVE ON PROD as `d057a34f`, do NOT undo.** A new
`"Not implemented"` member of `WorkflowControlStatus`, applied to this one domain; a NOT BUILT
summary; a per-subflow `gaps` line naming what is missing; a red banner on the domain detail; and a
simulator warning that fires before it walks the domain. `tests/workflow-control.test.ts` pins all of
it, including that no OTHER domain is mislabelled `Not implemented`. The five subflows and their
steps were KEPT ON PURPOSE — they are the specification if this is ever built.

**Never tell the owner an offer was approved by anyone** — nothing approves offers today.

**How to apply:** `workflow-control/definitions.ts` lists workflows that were DESIGNED, not ones that
are wired. Confirm against the database before describing any of them as live.

**How to apply:** enumerate approval workflows from the DATABASE (step tables + repeated
approver/decision columns), not from module names or `workflow-control/definitions.ts` — the registry
lists workflows that were designed, not the ones that are wired. Related:
[[dm-approval-chain-drops-the-ceo-never-the-nsm]],
[[marketing-manager-chain-target-is-sales-only]].
