---
name: direct-order-sales-month-is-a-finance-step-not-a-bug
description: "An approved direct order with sales_month=NULL and no DirectReq batch is NOT broken — Finance books the month only once the rep COLLECTS the cash, so unbooked = money not yet arrived, never a Finance backlog: never chase Ahmed. setDirectOrderSalesMonth is what injects into Source of Sales."
metadata: 
  node_type: memory
  type: project
  originSessionId: bc421ac0-542e-4974-af6d-0c747e853c5c
  modified: 2026-10-02T16:34:24.183Z
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

**What an unbooked approved order means: THE MONTH FOLLOWS THE MONEY** (owner ruling 2026-08-29).
The sequence is **rep collects the cash → Ahmed (Finance) books the month → the sales enter Source of
Sales**, so an approved order with no sales month means the money has not arrived — the correct,
intended state, not a queue on Finance. **Never chase Ahmed over unbooked orders**, and age them on
`collection_date` (the date the rep promised the money), never `decided_at`. The real late-collection
signal is `paid_amount IS NULL AND collection_date <= today`, which is orthogonal to booking. Measured
2026-08-08 — not one order in the system had a sales month; 3 approved orders worth
**EGP 43,925.50** had been unbooked since 2026-08-04 (an age from approval — the wrong clock).
Rejected/held having none is correct; approved having none is a rep who has not collected yet.
**Superseded 2026-10-02:** previously "approved having none is money waiting on a human; worth raising that nothing surfaces it to Finance" — the owner's 2026-08-29 ruling in [[direct-order-sales-month-is-finance-owned]] (an unbooked order is not a late Finance Manager).

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
Gharbia 2 (Mahalla) by hand. **An agent never books an unbooked order into any month, and never
offers to** (owner, 2026-08-29 — Finance alone chooses the month); when reporting one, flag that a
month he has hand-written would double-count if Finance booked it there.
**Superseded 2026-10-02:** previously "never book one into a hand-written month without asking first" — the owner's 2026-08-29 rule in [[direct-order-sales-month-is-finance-owned]] forbids the booking and the offer outright.
Note also that the module's own figure can differ from his (that order computes
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
