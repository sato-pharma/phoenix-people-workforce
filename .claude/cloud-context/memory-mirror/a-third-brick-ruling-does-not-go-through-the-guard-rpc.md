---
name: a-third-brick-ruling-does-not-go-through-the-guard-rpc
description: "Moving a held customer to a THIRD brick takes four hand steps, because `sos_map_guard_decide_and_move_sales` only takes approved/rejected, a within-AREA brick change is never held at all, and an ordinary approval moves NO sales rows."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T22:28:33.026Z
---

Answering a mapping-guard hold with a brick neither side proposes cannot be done with one call.
Measured on production 2026-10-10 while executing his ruling "move the three third-answer holds to
the normalizer's brick" (holds 3571/3495, customer كريم عبدالدايم, IS/463353, B153-4 → B151-2).

- **`sos_map_guard_decide_and_move_sales` takes `approved` or `rejected` only** — `p_actor`,
  `p_decision`, `p_hold_id`, `p_lock`. There is no target-brick argument, so a third answer is:
  reject the hold **without** the lock (a refusal writes nothing to the mapping, but `p_lock` would
  stamp confidence 100 on the brick you are rejecting), update the map row, then stamp the lock.
- 🔴 **A brick change INSIDE the same area is not held by the guard at all.** `B153-4 → B151-2` are
  both area `AB3`, region `AB`, and the plain `update … returning id, brick_id` came back with the
  new brick and **no hold raised** — `sos_map_guard_customer` returns early when neither brick nor
  area changes region/area. So there is no new hold to approve, and nothing stamps the lock for you.
- 🔴 **An ordinary approval moves NO sales rows.** `sos_move_brick_sales_after_hold` returns `null`
  unless the before-brick's `superseded_by_brick_id` equals the after-brick — it exists for RETIRED
  bricks folded into successors, not for customer corrections. `brickMove: null` is the normal case.
  What re-points the already-imported rows is `applyHistoricalReconciliation({distributorCode,
  customerCode, actorLoginId})` → `sos_reconcile_import_rows_from_customer_map` (4 rows, 2 batches
  refreshed here). See [[a-timed-out-reconcile-refresh-is-never-retried-by-re-running-it]].
- **The lock, replicated by hand, is exactly:** `source = 'owner-ruling-' || <Cairo YYYY-MM-DD> ||
  '-hold' || <holdId>`, `confidence = 100`, `mapped_by = <actor>`, `updated_at = now()`, **plus a
  hand-written `sos_map_change_log` row** (`action 'update'`, `outcome 'applied'`, reasons
  `['you locked this mapping: no upload may move it again']`, before/after json) — the RPC writes
  that log row itself because its own lock update is invisible to the guard.
- Only `confidence = 100` makes the monthly self-heal skip the row, so a third-brick move that stops
  after the update is silently temporary.

Related: [[zeroing-is-bonus-turns-free-goods-into-sales]] on flags that pass silently.
