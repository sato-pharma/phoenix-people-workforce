---
name: direct-order-sales-month-is-finance-owned
description: "OWNER RULE — an agent NEVER books a direct order into a sales month, and never offers to: Finance alone chooses it, and he chooses it when the REP COLLECTS THE CASH, so an unbooked order means the money has not arrived — clock it on collection_date, never decided_at. Also: never derived from the approval date, and changing it must rebuild BOTH periods."
metadata: 
  node_type: memory
  type: project
  originSessionId: d7876385-32d4-4aa5-880a-8afbb11a769b
  modified: 2026-08-04T18:30:18.930Z
---

## 🔴 OWNER RULE, 2026-08-29 — AN AGENT NEVER BOOKS A SALES MONTH. NOT EVEN WHEN ASKED TO OFFER.

His words, said six times over: **"never never never never never never put direct order sales in
its months without the finance who choose the month. The finance only choose the months. You never
put it automatic."**

**This forbids the OFFER, not merely the action.** What triggered it: on 2026-08-29 I diagnosed why
Finance's confirmed collections were not moving August's direct sales — correctly; the two steps are
separate by design and 8 approved orders worth EGP 252,868.80 were simply unbooked — and then closed
the reply with *"tell me to book all 8 into 2026-08 and I will do it now."* The diagnosis was right
and the offer was the error. Do not end a direct-order answer with a booking offer, do not propose a
month, do not suggest a backfill sweep, do not build anything that books one on a schedule or on
approval or on collection, and do not treat the owner's own Super Admin rights as a shortcut around
Finance — **he holds the power and still will not use it that way.**

**Report the gap; leave the act to Ahmed.** Naming the unbooked orders, their value and their age is
useful and wanted. Naming the month they *should* go in is already too far — that is the decision
itself, and the whole reason the step exists is that the approval month is frequently the wrong one.

**Why the pull toward automating it is so strong, and must be resisted.** Every surface makes it look
like an oversight: the order is approved, the money has arrived, the badge is red, and the fix is one
field. It reads as a stuck queue. It is not — it is a human judgement the owner has deliberately kept
out of the software, because booking a month moves real money between periods and the wrong month is
not visible afterwards. An automated booking would be *silently* wrong in exactly the cases the rule
exists for.

Related: [[never-auto-publish-deductions-owner-confirms-first]] and
[[system-flags-expenses-never-rejects]] — the same shape, three times: **the system surfaces, the
human decides.**

## 🔴 OWNER RULE, 2026-08-29 — THE MONTH FOLLOWS THE MONEY. AN UNBOOKED ORDER IS NOT A LATE FINANCE MANAGER.

His words: **"Ahmed puts the sales months based on the collection. So if the reps didn't make the
collection, he will not put in the sales months. So it is not him."**

So the sequence is **rep collects the cash → Ahmed books the month → the sales enter Source of
Sales.** An approved order with no sales month means the MONEY HAS NOT ARRIVED, and that is the
correct, intended state — not a queue anyone is sitting on. **Never chase Ahmed over unbooked
orders.** I did exactly that on 2026-08-29 ("tell Ahmed there are 8 orders awaiting a month, the
badge should read 8") and it was wrong twice over: wrong person, and nothing was even late.

**The clock is `collection_date`, NEVER `decided_at`.** `collection_date` is the date the REP
promised the money, captured as required at submit. Measured on production the same day: all 8
approved-unbooked orders had a promised date in the FUTURE (2026-09-03 → 2026-09-25), so not one
rep was late either. Ageing the same rows from the approval date made them look 3–9 days overdue.
**Two different clocks, opposite verdicts, and only the collection one means anything.**

**The consequence to state whenever this comes up: money promised in September books into
SEPTEMBER.** 220,664.40 of that 252,868.80 was promised 10–25 Sept, so it was never August's to
lose. An unbooked order at month end is not a hole in the closing.

**The real late-collection signal is `paid_amount IS NULL AND collection_date <= today`**, and it
is orthogonal to booking — on 2026-08-29 all 6 such orders (63,460.80, reps Nosiba / Taha / Dina)
were ALREADY booked into 2026-08. So an order can be in the month with the cash still outstanding;
booked and collected are not the same question and must never be reported as one.

🐛 **`getDirectOrderUnbookedBadge` (`service.ts`) measures the wrong clock** — it ages from
`decided_at` against `APPROVALS_SLA_THRESHOLDS.directOrderMonth` (5 days), so on 2026-08-29 it
showed Ahmed "8 unbooked, OVERDUE" when every one was early, six of them by a month. A badge that
cries wolf is the thing that teaches people to ignore badges. Do not "fix" it by booking anything.

Related: [[direct-order-sales-month-is-a-finance-step-not-a-bug]] ·
[[dv-evidence-window-same-day-submits]] (same shape: a window read on the wrong day reads as a
measured zero).

Owner decision 2026-08-03 (PR #1666), **restated by the owner as a GOLDEN RULE 2026-08-04**:
CEO approval NEVER injects sales. Injection happens ONLY when Finance selects the month. No month
= in no month, silently absent from SoS by construction — and that absence must be SHOWN in UI
("awaiting Finance month"), never left implicit.

`direct_order_requests.sales_month` used to be set to the month of the CEO's final approval. It is
now chosen explicitly, per order, by **Ahmed El Maraghy (HR_ID `B-185`, Finance Manager)** or a
**Super Admin**. CEO and SFE Manager see it, read-only.

**Incident 2026-08-04:** a design narrative claimed "approved = injected" and that 5 approved
orders on phantom pharmacies had contaminated SoS. Live check: all 5 had `sales_month = null`,
zero rows injected — the rule had already protected the numbers. Never narrate or reason from
injection-on-approval; verify `sales_month` before claiming contamination.

**Gated on the HR_ID, not the "Finance Manager" ROLE — deliberately.** This moves money between
months; a second Finance Manager hired later must not inherit it silently.
`DIRECT_ORDER_FINANCE_HR_ID` in `src/lib/direct-orders/finance-authority.ts` is the one line to
change if the duty moves (it was `DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID` in `service.ts` until the
2026-08-11 second review re-homed every "may this person do Finance's job" question into that
module; re-verified live 2026-08-29). Do not "improve" this into a role check without asking.

**Changing a month must rebuild BOTH periods** — the old one to take the value out, the new one to
put it in. `setDirectOrderSalesMonth` does this. Rebuilding only the new month counts the sales
twice; only the old, and they vanish.

**No month = counts in no month.** `phx_rebuild_direct_order_sos_batch` filters on
`sales_month = p_period`, so a null month never reaches Source of Sales. That is intended, not a bug.

**The decision RPC coalesces.** `sales_month = case when p_next_status = 'approved' then
coalesce(p_sales_month, sales_month) else sales_month end`. The service now passes null, so a bare
assignment would blank a month Finance set BEFORE approval. Migration
`20260803160000_direct_orders_finance_sales_month.sql`, applied to staging + production 2026-08-03.

**How to apply it:** when touching the decision RPC, read the live body back with
`pg_get_functiondef` first and change only the line you mean to. A draft written from memory got the
error codes and the step guard wrong. The migration must also land before the merge — see
[[railway-deploy-applies-no-migrations]].

**Read [[direct-order-sales-month-is-a-finance-step-not-a-bug]] with this one — two halves of the
same rule, cross-linked 2026-08-23.** That file carries the operational danger this one does not:
🔴 the owner books some months (July) BY HAND straight into `source_of_sales_import_rows`, leaving
the original request unbooked — so giving such a request a sales month later injects the SAME units
a second time. Never book an unbooked order into a month he has hand-written without asking first.
