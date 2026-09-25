---
name: recording-a-marketing-decision-by-rpc-skips-audit-and-alerts
description: "Calling phx_decide_marketing_request_step directly moves the request correctly but fires NO notification and writes NO audit row — both live above it in decideMarketingRequestWorkflow."
metadata:
  type: reference
---

`phx_decide_marketing_request_step(p_step_id, p_request_id, p_decision, p_decided_by,
p_decision_note, p_decided_at)` is atomic and complete **for the data**: it closes the step, opens
the next rung, updates the request row and writes `marketing_request_events`, all in one
transaction. That is why it is the right tool for recording a decision a human already made offline.

**What it does NOT do:** the audit row and every notification — in-app, push, email, Telegram — are
written by `decideMarketingRequestWorkflow` *around* the RPC, not inside it. Call the RPC on its own
and the next approver is never told the request has arrived. It sits in their queue, correct and
silent.

Confirmed on production 2026-08-19: the CEO's approval of `MKT-REQ-20260818-8C628BF4` was recorded
this way, and `notification_deliveries` holds **0** rows for B-185 on that request — against a full
in-app + push + email set for `MKT-REQ-20260816-8E4E42C4`, which the CEO decided through the app
40 minutes earlier.

**So: after an RPC-recorded decision, say plainly that the next approver was not alerted**, and
offer to raise the alert rather than assuming the queue speaks for itself. Sending it is an outbound
message to a real person — ask first ([[never-fire-bulk-emails-ever]] is the harder rule next door).

**UPDATE 2026-09-06 — there is now a named cure, so stop hand-rolling one.**
`dispatchMarketingAssignmentEmail(requestId)` sends the `request_assigned` notice for whatever rung
a request is CURRENTLY on, and is exposed in production as
`GET /api/cron/marketing-assignment-backfill` (`Bearer $CRON_SECRET`), which sweeps every pending
request. Safe to call repeatedly — an already-notified rung is a no-op at the UNIQUE idempotency
key, not a second email — so the blast radius is only ever the rungs that were never told. Built
for exactly the 8C628BF4 miss described above. Verified on production 2026-09-06:
`checked: 18, dispatched: 2`, and those two were the only ones intended. Read `CRON_SECRET` from
**Railway**, never `.env.production` — that file's copy is stale (35 chars against the live 64).

A REOPENED rung is the one case where "already notified" is a lie, and it needs the epoch:
[[reopening-a-rejected-marketing-request-is-a-db-op-plus-the-epoch]].

Driving the service from a throwaway Node script is not a workaround: it imports
`@/emails/general-notification`, and Node's type-stripping cannot parse `.tsx`
(`ERR_UNKNOWN_FILE_EXTENSION`). The test harness stubs those imports; a loose script does not.

Related: [[nothing-blocks-a-marketing-request-after-the-ceo]].
