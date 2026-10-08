---
name: a-returned-direct-order-has-no-reassign-and-no-close-button
description: "The Needs You board tells you to \"reassign or close them on the Direct Orders screen\" — but NO such control exists anywhere in Phoenix. Stuck Approvals covers weekly plans and excuses only, and cancelHeldDirectOrder refuses anything that is not `held`. A returned order stranded on a resigned requester can only be cleared by a database write."
metadata:
  node_type: memory
  type: project
  originSessionId: b22fdc48-d234-4df2-8367-211d96bc39ea
  modified: 2026-10-08T00:55:41.449Z
---

`orphanedRequestModuleScreens` sends the board's row to `/admin/direct-orders` and the adapter's
copy reads "reassign or close them on the Direct Orders screen". **Neither verb has a control
there.** Measured 2026-10-08, hunting for one before writing any SQL:

- **Reassign:** `/admin/approvals/stuck` ("Stuck Approvals — Needs Reassignment") covers **weekly
  plans and excuses only** — `/api/weekly-plans/[id]/reassign` and `/api/excuses/[id]/reassign`.
  Nothing in `src/lib/direct-orders/` writes `requester_hr_id` on an existing row.
- **Close:** `cancelHeldDirectOrder` is the only cancel path and it refuses anything that is not
  `held` ("Only a held direct order can be cancelled"). A `returned` order has no exit at all.

So the board correctly finds the problem and then names a remedy the product cannot perform. Clearing
one is a direct production write (announced, §8), or building the control.

## What actually unsticks it, and what it costs

`reviseDirectOrder` gates on **ownership** — `canonicalHrIdKey(before.requesterHrId) !== actorHrId`
refuses — so changing `requester_hr_id` genuinely hands the order to the new person. Two constraints
bound who that can be:

- **`DIRECT_ORDER_REQUESTER_ROLES` is District Manager · Regional Manager · National Sales Manager ·
  Product Manager · Group Product Manager.** A **Medical Rep cannot own a direct order**, so "give it
  to the rep who covers that brick now" is not an option however obvious it looks.
- **Super Admin can already correct and resubmit any returned order on anyone's behalf** — so the
  owner never strictly needs a reassignment to clear one.

🔴 **A resubmit REPRICES from scratch on today's basis** and resumes at the lowest still-pending rung
— which for a CEO-returned order is the **CEO's own rung**. So "reassigning" a stranded order is
handing someone a money edit, not an administrative tidy. Read the `return` event's message before
proposing either verb: on the five closed on 2026-10-08, four were the CEO cutting the discount
("only 15%", "only 17%"), not an administrative accident.

## Closing one, safely

`status → 'cancelled'` (never `rejected` — nobody turned it down, and `rejected` inflates every
approver's rejection rate) plus `decided_at`. Nothing else moves:

- `trg_direct_order_weekly_sync_upd` fires on a status change but its loop is `where p is not null`
  over `old.sales_month`/`new.sales_month` — **null on any unapproved order, so no weekly rebuild
  runs.** Monthly Closing never saw it either.
- `trg_direct_order_requests_requester_storage_form` upper-cases `requester_hr_id` on write, so the
  storage form is `UPPER(btrim(...))`.
- `direct_order_events.event_type` has **no CHECK constraint**, so an audit row can carry any verb.
- Approval steps are deliberately left alone; an approver can only act when the request is
  `pending_approval`, so stale `pending` rungs on a cancelled order reach nobody's queue.

🔴 **Verifying the board is clear afterwards needs `isActiveLifecycleStatus`'s OWN set — `active`
and `on_leave`, nothing else.** A friendlier filter (adding probation, notice_period…) returns an
empty result for the wrong reason and reads exactly like a real all-clear. Sibling of
[[a-mismatch-query-hides-the-row-that-matches]].

Pre-image of the 2026-10-08 close: `au.bak_20261008_orphaned_direct_orders` (+ `_items`, `_steps`,
`_events`) — 5 requests, 66,475.20 EGP. Related: [[sos-monthly-closing-is-the-only-sales-truth]].
