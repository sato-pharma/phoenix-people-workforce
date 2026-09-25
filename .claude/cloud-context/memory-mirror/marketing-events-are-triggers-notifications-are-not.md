---
name: marketing-events-are-triggers-notifications-are-not
description: "A hand-run SQL decision on a marketing request DOES get a correct audit trail (DB triggers write marketing_request_events) but does NOT notify the next approver - notifyMarketingWorkflow lives in the service, not the database."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1fbda99d-0857-448d-9fb9-a270ce2878c5
  modified: 2026-08-26T20:17:18.079Z
---

Reading `src/lib/marketing-requests/service.ts` suggests the service writes the audit trail. It does
not. Two `AFTER INSERT OR UPDATE` triggers in production do:

- `marketing_request_steps_capture_event` -> `phx_capture_marketing_step_event()` on
  `marketing_request_approval_steps` — emits `step_opened` / `step_decided` / `step_commented`,
  actor = `coalesce(new.decision_by_hr_id, new.assigned_hr_id)`.
- `marketing_requests_capture_event` -> `phx_capture_marketing_request_event()` on
  `marketing_requests` — emits `request_status_changed` etc.

**So a decision applied by hand in SQL still produces a complete, correctly-attributed
`marketing_request_events` trail. Never hand-insert those rows — you will double them.**

**What direct SQL DOES skip: the notification.** `notifyMarketingWorkflow` and
`auditMarketingDecision` are called from `decideMarketingRequestWorkflow` in the service, *after*
the `phx_decide_marketing_request_step` RPC returns. Nothing in the database fires them. Verified
2026-08-26 on `MKT-REQ-20260825-09BB51CA`: after approving step 1 in SQL, step 2 went `current` and
its `step_opened` event was written, but `notification_events` had **no** `request_assigned` row for
the incoming approver. The next approver sees the request in their inbox (it reads the DB) but gets
no in-app / Telegram ping.

**How to advance a `returned` request by hand.** The RPC refuses anything whose step is not
`current`, so reopen first, exactly as `resubmitReturnedMarketingRequest` does, then call the RPC —
both inside one `DO` block so it cannot half-apply:

1. step: `status='current'`, `decision_at/decision_by_hr_id/decision_note = null`
2. request: `status='pending_approval'`, `returned_at = null`, `returned_step_sequence = null`
3. `phx_decide_marketing_request_step(p_step_id, p_request_id, 'approve', <hr_id>, <note>, now())`

Attribute the decision to whoever really made it, not to the rung's `assigned_hr_id` — the step
keeps its assignment, so the trail then reads "assigned to X, decided by Y", which is the truth.
The RPC refuses a self-decision (requester = decider) in the database, so that guard still holds.

Related: [[how-to-attribute-a-production-write]] · [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]]
