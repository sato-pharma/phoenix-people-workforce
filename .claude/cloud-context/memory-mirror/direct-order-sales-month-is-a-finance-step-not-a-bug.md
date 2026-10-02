---
name: direct-order-sales-month-is-a-finance-step-not-a-bug
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: THE MONTH FOLLOWS THE MONEY. AN UNBOOKED ORDER IS NOT A LATE FINANCE MANAGER ... Never chase Ahmed over unbooked orders (see `direct-order-sales-month-is-finance-owned`). Older text follows: An approved direct order with sales_month=NULL and no DirectReq batch is NOT broken — booking is a deliberate second step Finance performs; setDirectOrderSalesMonth is what injects into Source of Sales."
metadata: 
  node_type: memory
  type: project
  originSessionId: bc421ac0-542e-4974-af6d-0c747e853c5c
  modified: 2026-08-10T13:22:03.422Z
---

**Do not 'fix' this.** On 2026-08-08 I reported to the owner that "approved direct orders are not
reaching Source of Sales — a defect", inferring it from NULL columns before reading the code. It is
a deliberate two-step design and the code contradicted me.

The tell that looks alarming and is normal:
- approved `direct_order_requests` with `sales_month = NULL` **and** `sos_batch_id = NULL`
- **0** `DirectReq` batches and **0** `DirectReq` rows in Source of Sales
- complete approval chains with `decided_at` stamped

**Why it is correct.** `src/lib/direct-orders/service.ts` (~:2797) passes `p_sales_month: null` on
purpose — owner rule 2026-08-03: *"The sales month is NO LONGER derived from the approval date…
Finance chooses it per order… because the month an order is signed off in is frequently not the
month it should be booked into."* `phx_apply_direct_order_decision` then only injects under
`elsif v_row.sales_month is not null` — no `else`, so a null month silently skips injection, which
is the intended behaviour, not a swallowed error.

**The booking trigger is `setDirectOrderSalesMonth`** (`service.ts` ~:4488, Finance / System Admin
only): it writes `sales_month`, then calls `phx_rebuild_direct_order_sos_batch` for **every** period
the move touched (old and new, de-duplicated), audit-logs, and pings the sheet. That call is what
puts direct sales into SoS.

**What IS worth raising** is operational, not code: nothing surfaces "approved, awaiting a sales
month" to Finance. Measured 2026-08-08 — not one order in the system had a sales month; 3 approved
orders worth **EGP 43,925.50** had been unbooked since 2026-08-04. Rejected/held having none is
correct; approved having none is money waiting on a human.

**Knock-on:** while no approved order has a `sales_month`, the marketing ROI direct branch can never
match either (its predicate is `dor.sales_month = any(periods)`) — so "direct sales show as zero" has
two independent causes and this is one of them. See
[[marketing-roi-direct-branch-join-was-dead]].

**🔴 THE OWNER BOOKS JULY DIRECT BY HAND, so every unbooked request is a DOUBLE-COUNT waiting to
happen** (confirmed by him 2026-08-10: "added it manually for july the same as october and zayed").
He writes the units straight into `source_of_sales_import_rows` + `phx_refresh_sos_fact_rollup` and
the hardcoded overlay, leaving the original `direct_order_requests` row sitting at
`pending_approval`/`approved` with `sales_month = NULL`. If Finance ever gives that row a July sales
month, `phx_rebuild_direct_order_sos_batch` injects the SAME units again — the area doubles AND the
overlay stops matching, which silently collapses the whole line to region-only
([[july-direct-overlay-and-rollup-must-move-together]]). Measured 2026-08-10: **9 unbooked requests**,
two of them already `approved` (Royafloxacin 100 / 4,600.00; Lacto Advanced 1 144 / 38,016.00).
Confirmed duplicate: request `9dff4ca4` (Lacto Advanced 1, 288 u) is the +288 / 68,000.00 he added to
Gharbia 2 (Mahalla) by hand. **Never "book" an unbooked order into a month he has hand-written
without asking first** — and note the module's own figure can differ from his (that order computes
69,379.20 at 27% off 330, against the 68,000.00 he booked), because overlay value is carried as
supplied, never recomputed ([[direct-order-pricing-rule-locked]]).

Related: [[list-migrations-reports-ledger-not-reality]] (query the live `pg_proc` body, not the
migration file — reading the live RPC is what corrected me here).

**Read [[direct-order-sales-month-is-finance-owned]] with this one — they are two halves of the same
rule and did not link to each other until 2026-08-23.** That file carries what this one does not:
the setter is gated on the **HR_ID** `B-185` (Ahmed El Maraghy, Finance Manager) and NOT on the
"Finance Manager" role, deliberately, so a second Finance Manager hired later does not inherit the
power to move money between months; changing a month must rebuild **both** periods (old and new) or
the sales double-count or vanish; and the decision RPC `coalesce`s, so a bare assignment would blank
a month Finance set before approval.
