---
name: reopening-a-rejected-marketing-request-is-a-db-op-plus-the-epoch
description: "A REJECTED marketing request has no reopen path in the app — resubmit refuses anything but 'returned'. Reopen the rung in SQL, then the reopen EPOCH is the only reason the approver is ever told again."
metadata:
  type: reference
---

> **SUPERSEDED IN PART, 2026-09-06 — THERE IS A BUTTON NOW. Do not hand-write the SQL below.**
> PR #3353 shipped `reopenRejectedMarketingRequest` (service), `POST /api/marketing-requests/[id]/reopen`,
> and a **Reopen** panel on the Case File. **Super Admin only** (owner: "the reopen is only a super
> admin feature"), a reason is required, and it calls the atomic RPC
> `phx_reopen_rejected_marketing_request` — live in production and staging. Note the CEO seat (`AA`)
> holds role **CEO**, not Super Admin, so the refuser is deliberately not the reopener; the owner
> reopens as `B-10`. **The rest of this file is still the WHY** — it is what the feature encodes,
> and the epoch trap below is exactly what makes the notification land.

**`rejected` is terminal in the marketing module and nothing in the UI reverses it.**
`resubmitReturnedMarketingRequest` guards on `existing.status !== "returned"` and throws
*"Only a returned marketing request can be resubmitted."* — so a reject cannot be walked back the
way a return can. That was true until 2026-09-06; the banner above is the current answer.

**The sanctioned reopen is three writes, then one call.** Done on production 2026-09-06 for
`MKT-REQ-20260831-2E355071` and `MKT-REQ-20260831-42B1E366`, both refused by the CEO on 09-03:

1. the refusing rung → `status='current'`, `decision_at`/`decision_by_hr_id`/`decision_note` all
   NULL (mirrors what the resubmit path does to a returned rung);
2. every rung the reject closed out → `skipped` back to `pending`
   ([[marketing-reject-terminalises-applied-to-prod-2026-08-13]] is what put them there);
3. the request → `status='pending_approval'`, `rejected_at=NULL`.
   Earlier approved rungs are left ALONE — reopening at the CEO does not re-ask the three below him.

Then `GET /api/cron/marketing-assignment-backfill` on **production** with `Bearer $CRON_SECRET`
raises the alert — see [[recording-a-marketing-decision-by-rpc-skips-audit-and-alerts]].

🔴 **The whole thing turns on the REOPEN EPOCH, and getting it wrong is silent.**
`notification_deliveries.idempotency_key` is UNIQUE and an ordinary rung keys on its STEP ID — a
rung that has already told its approver can therefore *physically never tell them again*. The
refusing rung has already notified (that is how the approver knew to refuse it), so a naive reopen
leaves the request sitting on his desk with no notice, and the sweep reports
`already_notified` — which reads as *he was told*. What rescues it is `marketingReopenEpoch`:
`marketing_request_events` gains a second `step_opened` row for that sequence, written by the
`marketing_request_steps_capture_event` trigger **however the reopen was recorded, including
straight in the database**, and 2+ openings re-key the notice. **Verify `times_opened = 2` on the
reopened sequence BEFORE dispatching** — one opening means no epoch and no notification.

Two things to check before firing the sweep, because it walks EVERY pending request:
- the epoch fix (`1ea85b7eb`) must be an ancestor of the live `/api/healthz` `revision`, or
  production computes the step-id key and sends nothing;
- blast radius is not the step-id delivery count — a rung opened more than once keys on the epoch
  instead, so count `step_opened` rows per current rung to find the real dispatch candidates.

**Nothing is lost by clearing `decision_note`:** the refusal text survives forever in
`marketing_request_events` (`kind='step_decided'`, append-only), which is where to read a reason
back from. Pre-image of both rows: `marketing_reopen_backup_20260906`.
