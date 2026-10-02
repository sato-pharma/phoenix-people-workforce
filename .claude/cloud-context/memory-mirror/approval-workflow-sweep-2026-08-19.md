---
name: approval-workflow-sweep-2026-08-19
description: "Inventory of Phoenix approval workflows swept 2026-08-19 — exactly THREE chain-shaped step tables (vacation, direct orders, marketing). Offers are no longer fictional: ats_offers is LIVE since 2026-08-21 with ONE Super-Admin approval, enforced by markOfferSent on approved_at; only the candidate-facing half is unbuilt."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 38cac8f5-eef9-4ca8-9b4c-3c23b0534074
  modified: 2026-10-02T16:32:37.229Z
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

🔴 **THE INTERNAL OFFER IS LIVE AND GOVERNED SINCE 2026-08-21 — ONE Super-Admin approval before
sending; only the CANDIDATE-FACING half of the offer & hiring workflow is still not built.**
`public.ats_offers` was applied to production on 2026-08-21 (staging first): prepare → submit →
approve → send → record-answer run through the workflow registry, approval is Super-Admin-only, and
`markOfferSent` (`src/lib/recruitment/offers.ts`) refuses while `ats_offers.approved_at` is null —
the registry alone would let `app_offer_sent` fire from `offer_initiated`, straight past approval
([[offer-chain-was-live-in-the-registry-with-a-hole-past-approval]]). Still not built, by owner
decision 2026-08-21: accept/reject links, tokens, an expiry job, and any email to the candidate.
**Superseded 2026-10-02:** previously "THE WHOLE OFFER & HIRING WORKFLOW IS FICTIONAL — owner decided 2026-08-19 to leave it ('skip offers now'); do not build it" — the owner's "one approval before sending" answer and the `ats_offers` build of 2026-08-21 replaced it.

As swept on 2026-08-19, `workflow-control/definitions.ts` documented an `offer-hiring` workflow in
full detail — `job_offers`, `job_offer_audit_logs`, secure accept/reject tokens with expiry,
candidate emails, employee creation, vacancy fill — and **none of it existed** then. Verified in
production 2026-08-19: `job_offers` = 0 tables, `job_offer_audit_logs` = 0, and
`table_name like '%offer%'` returned **zero rows of any kind**. (`job_offers` /
`job_offer_audit_logs` were never created and are not planned — `ats_offers` is the offer table.)

As swept on 2026-08-19, everything around it was scaffolding with no floor:

- `src/config/offer-approval.ts` (`OFFER_APPROVAL_ALWAYS_ROLES`, `OFFER_CEO_APPROVAL_CAPS`,
  `resolvePositionApprovalThreshold`) had **zero call sites outside its own file** — it was
  **DELETED on 2026-08-29** by owner decision; approval is one Super-Admin step at any figure, and a
  threshold chain is a fresh decision if ever wanted, not a file to revive.
- Stages `offer_draft` / `offer_pending_approval` / `offer_approved` / `offer_generated` /
  `offer_negotiation` and the six `app_offer_*` action keys exist in `recruitment/types.ts` and get a
  colour in `recruitment-workspace.tsx`, but **none appear in `plainTransitionNextStatus`** in
  `recruitment/applications.ts` — so no code path can reach any of them.
- `ats_applications.offer_id` is a dangling column; `senior_approval_status` /`senior_approved_by` /
  `senior_approved_at` are **read** in `recruitment/db.ts` and **never written** anywhere.

Usable inputs if a threshold chain is ever wanted: `ats_requisitions.salary_band_max` +
`hiring_manager_hr_id` are exactly what the (deleted) threshold resolver wanted. Active seats are singular — Super Admin = Omar Gawish,
Finance Manager = Ahmed El Maraghy, CEO = Anwar Gaweesh, Talent Acquisition = Youmna Kotb; **there is
no "HR Manager" role holder** despite the workflow doc naming one as the approver.

**Why this matters beyond recruitment:** the workflow-control page USED to present `offer-hiring` as
`status: "Active"`, `riskLevel: "High"`, so anyone reading it believed offers were governed.
**LABELLED HONESTLY 2026-08-19 in #2203 — LIVE ON PROD as `d057a34f`, do NOT undo.** A new
`"Not implemented"` member of `WorkflowControlStatus`, applied to this one domain; a NOT BUILT
summary; a per-subflow `gaps` line naming what is missing; a red banner on the domain detail; and a
simulator warning that fires before it walks the domain. `tests/workflow-control.test.ts` pins all of
it, including that no OTHER domain is mislabelled `Not implemented`. The five subflows and their
steps were KEPT ON PURPOSE — they are the specification if this is ever built. Since `ats_offers`
went live the domain reads **`Partially implemented`** — a status reserved for `offer-hiring` alone,
and `tests/workflow-control.test.ts` pins that it is never `Active` while the candidate-facing half
is missing and never `Not implemented` now the offer runs.
**Superseded 2026-10-02:** previously the domain was labelled `Not implemented` — relabelled `Partially implemented` once `ats_offers` shipped 2026-08-21 (`src/lib/workflow-control/definitions.ts`).

**Never tell the owner an offer was approved unless its `ats_offers.approved_at` is set** — a
Super Admin's approval is the only approval an offer has, and nothing candidate-facing (acceptance
link, applicant email) exists to report on.
**Superseded 2026-10-02:** previously "nothing approves offers today" — the Super-Admin approval gate on `ats_offers` (2026-08-21, [[offer-chain-was-live-in-the-registry-with-a-hole-past-approval]]) replaced it.

**How to apply:** `workflow-control/definitions.ts` lists workflows that were DESIGNED, not ones that
are wired. Confirm against the database before describing any of them as live.

**How to apply:** enumerate approval workflows from the DATABASE (step tables + repeated
approver/decision columns), not from module names or `workflow-control/definitions.ts` — the registry
lists workflows that were designed, not the ones that are wired. Related:
[[dm-approval-chain-drops-the-ceo-never-the-nsm]],
[[marketing-manager-chain-target-is-sales-only]].
