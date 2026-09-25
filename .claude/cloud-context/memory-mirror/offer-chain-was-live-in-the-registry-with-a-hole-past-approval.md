---
name: offer-chain-was-live-in-the-registry-with-a-hole-past-approval
description: "The recruitment offer chain was already live in workflow_registry_modules with 12 role-gated actions — but app_offer_sent is reachable from offer_initiated, straight past approval. The one-approval rule is enforced in markOfferSent on approved_at, NOT by the registry."
metadata: 
  node_type: memory
  type: project
  originSessionId: b37bf0c4-a7f9-4d42-b7e5-280ac5ac183a
  modified: 2026-08-21T18:36:27.597Z
---

Found 2026-08-21 while building `ats_offers`.

**Nothing about the offer flow needed designing.** `workflow_registry_modules` already carried the
whole chain — 12 actions, role-gated, with approval reserved to Super Admin, which is exactly the
owner's answer of "one approval before sending". What was missing was only a place to store the
numbers: no `%offer%` table existed in production at all, and `ats_applications.offer_id` was NULL
on all 7 applications and has never been populated (it is now commented DEAD in the schema).

**`public.ats_offers` is now LIVE in production** — `20260821160000_ats_offers.sql` applied to
`ozucdzovmcqvepbozvqf` on 2026-08-21 at 21:32 Cairo, staging (`cifwmndunmlxjhyjugxa`) first.
Verified against `pg_class`, not the ledger: 19 columns, RLS on, one `service_role` policy, grants
to `service_role` only (`anon`/`authenticated` revoked), the partial index
`ats_offers_pending_approval_idx`, and all four constraint kinds (`c,f,p,u`). Purely additive —
`ats_applications` still held 7 rows and `ats_candidates` 549 immediately after.

**The hole.** The registry lets `app_offer_sent` fire from `offer_initiated` as well as from
`offer_generated`. That is a path from "we are thinking about an offer" straight to "the offer is
sent", with no approval in between — it would defeat the owner's rule silently, and no CI check or
registry test would notice.

So **the rule is enforced in TypeScript, not in the registry**: `markOfferSent`
(`src/lib/recruitment/offers.ts`) refuses on `ats_offers.approved_at` being null, never on the
application's stage. `tests/recruitment-offers.test.ts` makes that its headline assertion. If a
future session "simplifies" the guard to a stage check, the approval requirement disappears while
every test that reads the registry still passes.

`ats_applications.stage` stays the single status. `ats_offers` deliberately has no rival status
column and no version column — superseded terms belong in the already-append-only
`ats_application_events`.

Related: [[workflow-registry-drifts-from-the-typescript-chain]] ·
[[ats-candidate-children-one-has-no-fk-and-one-is-a-view]]
