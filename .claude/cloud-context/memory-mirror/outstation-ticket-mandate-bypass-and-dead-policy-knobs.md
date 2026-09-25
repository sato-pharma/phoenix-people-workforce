---
name: outstation-ticket-mandate-bypass-and-dead-policy-knobs
description: "Outstation auto-pay could be reached with no ticket evidence via a client-settable offlineCaptured flag; two admin policy knobs were decorative. Fixed on codex/outstation-ticket-evidence-authority (never exploited)"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-01T09:20:42.189Z
---

Three defects on the outstation expense → payroll money path, all confirmed in code:

1. **The ticket mandate never reached the decision.** `submitOutstationRequest` computed
   `decisionStatus` from only `eligibilityStatus === "not_eligible"` + `campaignRuleRejection` +
   `governorateReviewRequired`. The train/bus ticket rule was a separate `throw` **skipped when
   `calculation.offlineCaptured`** — so an offline ticket-based claim with zero attachments became
   `accepted_by_system` and `pushAcceptedOutstationExpenseToPayroll` wrote it to the ledger
   pre-approved (`hrApproved: true`). Missing tickets only downgrade `eligibilityStatus` to
   `needs_review` (service.ts ~964), which the decision treated as accept.
2. **`offlineCaptured` was client-supplied** — `app/api/outstation/submit/route.ts` did
   `Boolean(body.offlineCaptured)`, so any caller could self-declare offline and skip the mandate
   without ever being offline.
3. **`gps_accuracy_threshold_meters` and `max_offline_sync_delay_hours` were decorative** — read,
   written, and rendered in the policy editor, enforced nowhere.

## ✅ Never exploited (production, read-only 2026-08-01)

**8 outstation requests total · 0 with `offline_captured = true` · 0 ticketless train/bus.**
Live policy for all 3 roles (`outstation_policy_rules`, NOT `outstation_expense_policies`):
`requires_ticket_attachment = true`, GPS 100 m, offline window 8 h. Preventive fix, no cleanup owed.

## Fix — ✅ **MERGED 2026-08-01T09:20Z as `424386fb`** (PR #1579, was `07c64930`)

Verified on `origin/main`: shared rule exported + called by the live path, offline exemption gone,
both policy knobs enforced, submit route pins `offlineCaptured: false`. Remote branch auto-deleted;
local branch `codex/outstation-ticket-evidence-authority` + worktree `_wt-outstation-decision`
survive and need owner approval to remove. ~~**Ships on the 2-hourly prod deploy cron, not on merge.**~~
**CORRECTED 2026-08-27:** that is backwards now — a merge to `main` ships to PRODUCTION IMMEDIATELY (Railway auto-deploy on push, since 2026-08-01). The 2-hourly GCP cron is dead twice over: `deploy-cloud-run.yml` moved to a **4-hourly** schedule on 2026-07-26, then the whole GCP project went `BILLING_DISABLED` on 2026-08-01. Confirm what actually serves traffic by reading `revision` from `/api/healthz`. (Its twin memory was struck on 2026-08-23; this one was missed because the sweep was scoped by topic — see [[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]].)

- Extracted rule 4 as exported pure `outstationTicketEvidenceRejection()` in `decision.ts`; both
  `decideOutstationRequest` and the live submit path call it — one implementation, so the rule can
  no longer be green in tests and absent in production.
- Evidence counted from **files the server received** (`options.ticketAttachments`), never the
  client's `hasTicketAttachments` boolean (which `calculateOutstationExpense` still trusts for its
  *recommendation* only).
- Online + missing ticket → unchanged hard throw. **Offline + missing ticket → HOLD**
  (`decisionStatus = "submitted"`) instead of auto-accept — the offline path genuinely cannot carry
  files, so rejecting would punish legitimate captures.
- Both policy knobs now produce **holds, not rejections** (a fuzzy GPS fix or a late sync is a
  review signal, not proof of abuse). Multiple hold reasons join into one message; the
  governorate-only case still yields the exact original string (backward compatible).
- Submit route pins `offlineCaptured: false`. **Verified safe**: `mobile-outstation-wizard.tsx`
  early-returns into the local-draft path when `isOffline`, so a legitimate online submit never
  sent `true`; the real offline replay is `POST /api/outstation/sync-offline`, which sets the flag
  server-side.

Validation: typecheck, lint, **507 test files**, build all clean.

## Key insight for anyone touching this module

`decision.ts` rules 1–3 are **provably equivalent** to what the live path already computes —
distance and governorate are both folded into `calculation.eligibilityStatus` (byte-identical
reason strings, service.ts ~859-866), and `campaignRuleRejection` (service.ts:388-403) is rule 3
verbatim sharing the same exported constants. Only rule 4 was missing. That is why the fix is
surgical rather than a risky wholesale rewrite of a money path — **do not "unify" rules 1-3 by
feeding `decideOutstationRequest` null governorates**, which would silently drop the
same-governorate rejection.

Follow-up not taken (contained, out of scope): `app/api/outstation/calculate/route.ts:55` and
`capture-location/route.ts:36` still read `body.offlineCaptured`. Harmless because the persisted
decision is recomputed inside submit, which now pins it false.

Found by [[module-audit-2026-08-01-status]] (finding #3). Related:
[[outstation-expense-deep-audit-2026-07]] · [[prove-it-fails-verify-which-assertion-fired]].
