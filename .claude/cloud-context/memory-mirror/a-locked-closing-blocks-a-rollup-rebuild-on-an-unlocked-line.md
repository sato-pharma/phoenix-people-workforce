---
name: a-locked-closing-blocks-a-rollup-rebuild-on-an-unlocked-line
description: "A locked closing refuses a whole-batch rollup rebuild even when the row you are correcting is on an UNLOCKED line — every refresh RPC deletes the batch first, so one Pedia lock blocks a Head Office correction in that batch"
metadata:
  node_type: memory
  type: project
  originSessionId: abf9f7ad-6d41-471f-84f7-43a58d29f3a1
---

`phx_reject_write_to_locked_closing` matches on **(period, normalized_line)**, so a Head Office row in
a locked month is itself writable — `monthly_closing_locks` has no Head Office line. But every
refresh in the chain starts with `delete from <rollup> where batch_id = p_batch_id`, and a
distributor's batch carries ALL its lines, so the delete sweeps the locked Pedia and Anti Infective
rows and the statement-level trigger raises on them.

Measured 2026-10-10 on the EPDA-Pharmacies batches: September (`cf39e412`) rebuilt in **33.6s**
through `scripts/rebuild-source-of-sales-rollups.ts --apply`, because its only lock rows (Anti
Infective 2026-09) all had `unlocked_at` set. July (`1af5f034`) and August (`c43921c2`) were refused
by the script's own pre-check — `2 batch(es) fall in a locked closing: Anti Infective 2026-07,
… CNS …, Pedia …` — although the rows being corrected were Head Office.

🔴 **Read `unlocked_at is null`, never `locked_at is not null`.** The locks table keeps every
lock/unlock as its own row: July CNS has 9 rows and exactly 1 still active, September Anti Infective
has 3 and **0** active. Counting `locked_at` reports September as locked when it is open.

**Why:** a session that corrects the source rows and cannot refresh leaves the derived rollups
showing the pre-correction shape — the staleness class that left July 2026 653,299.13 EGP short on
the dashboard — so the half that landed must be reported as such, never as done.

**How to apply:** check the locks with the guard's own predicate before planning a correction in a
past month. Unlocked → run the sanctioned chain per batch. Locked → the source rows and the customer
map still take the fix, the derived rollups do not, and **unlocking is the owner's own click on the
Monthly Closing screen** — never a chat approval, and never worked around by hand-writing the
derived tables. Related: [[a-timed-out-reconcile-refresh-is-never-retried-by-re-running-it]].
