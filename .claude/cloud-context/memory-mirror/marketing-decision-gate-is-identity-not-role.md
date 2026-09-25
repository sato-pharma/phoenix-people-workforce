---
name: marketing-decision-gate-is-identity-not-role
description: "The marketing approval gate checks IDENTITY (hrId == step assignee, and not the requester), never the role — so a role sweep is the wrong test for it. Also: staging has ZERO pending marketing requests, so any approval test must build its own fixture."
metadata:
  node_type: memory
  type: project
  modified: 2026-08-26T17:55:00.000Z
---

**`getMarketingRequestDecisionSummary` gates on WHO YOU ARE, not what role you hold.** In order:
`requireMarketingDecisionActor` (needs any linked HR identity — it does **not** check the role),
a step with `status = 'current'`, `assertMarketingStepAssignedToActor` (`hrId` must equal the step's
`assigned_hr_id`), `assertNotDecidingOwnRequest`, then `status = 'pending_approval'`.

**So a classic role sweep — Regional Manager vs District Manager vs Medical Rep — proves nothing
here.** Every one of them is refused for the same reason a Super Admin would be: they are not the
assignee. The axis that actually gates is identity. Test: the assignee (allowed), a non-assignee
(refused), and the requester (refused).

**The requester case cannot isolate its own guard by default.** The requester is normally not the
assignee either, so `assertMarketingStepAssignedToActor` fires FIRST and you get *"not assigned to
your Phoenix identity"* — which looks like the own-request guard passed when it was never reached.
To test it, temporarily set `assigned_hr_id` to the requester's own id; the message then reads
*"you raised this marketing request, so you cannot approve, reject or return it."*

**Staging has NO pending marketing requests at all** (verified 2026-08-26: 217 requests, all
`archived`/`approved`/`rejected`; all 546 approval steps `approved`; 0 licence evidence files). Any
test of an approval path must therefore INSERT its own fixture — request + a `current` step + link
rows + evidence — and delete it afterwards. Two shapes bite on the way in:
`marketing_evidence_files.entity_type` is CHECK-constrained to `'customer' | 'pharmacy'` (**not**
`'marketing_pharmacy'`, which is what the audit `entityType` uses), and `marketing_requests`
requires a real `customer_id` and `request_type_id`.

**How to apply:** to exercise a marketing approval service without a dev server, set
`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from `.env.staging.rls.local` (its
service-role key IS valid for `cifwmndunmlxjhyjugxa` despite the stale comment saying otherwise;
its ANON key is dead — 401) and import the service through `tests/alias-loader.mjs`. Assert the
target ref before writing anything. See [[a-narrowed-select-disarms-every-gate-downstream-of-it]].
