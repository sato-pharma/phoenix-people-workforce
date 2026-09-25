---
name: july-2026-direct-sheet-incomplete-3-of-8-regions
description: "July 2026 Anti-Infective closing sits on a Direct sheet carrying 3 of the 8 region tags June had — D2/GZ/UE-1/UE-2 missing, so four regions' achievement % are wrong"
metadata: 
  node_type: memory
  type: project
  originSessionId: 12cbb8b7-ccc7-4d6c-851b-309d5beb799c
  modified: 2026-08-05T22:32:06.963Z
---

Audited 2026-08-02. The Monthly Closing target columns work (PR #1622, live on
`228ba34b`) — but **July's inputs are incomplete, so no July achievement % is safe to act
on.** The sheet is reporting correctly; the data behind it is short.

**July's Direct batch (uploaded 2026-08-02 03:46 Cairo) carries 3 of the 8 region tags
June's carried.** Missing: D2, GZ, OT, UE-1, UE-2.

| Region | Sheet shows | Realistic | Why |
| --- | --- | --- | --- |
| D1 | 85.2% | 85.2% ✅ | sound — but carried by D12 (189%) and D15 |
| AB | 29.6% | 29.6% ✅ | no Direct channel *ever*, fully targeted — the control case |
| UE | 35.0% | ~41–43% | UE-1/UE-2 Direct missing |
| CA | 33.9% | **~21%** | only region reading **too high** — see [[untargeted-area-taxonomy-and-closing-region-mismatch]] |
| D2 | 15.0% | ~64–86% | Direct sheet absent; Direct is **79% of D2's volume** and 6/6 prior months present, avg 123,256/mo |
| GZ | 12.7% | ~40% | GZ4 reversal (below) + Direct missing |

🔴 **GZ4 ±400-unit reversal spans two closings.** GZ4 normally trades 29–52 units/month.
IS-S posted **+200 RO001 and +200 SA001 in June**, then **−200 / −200 in July** — a
correction of a June mis-post. It inflated June by ~34,380 and deflates July by −32,166.
GZ4 carries no target, so the drag has no denominator. **Both months are wrong until it is
booked to the right period.**

**Royafloxacin (RO001) is a real line-wide problem, not an artifact** — it trails Saginko
in every region (AB 12.9% vs 38.0%; D2 10.8% vs 17.1%; only D1 clears 44%). Visible in
AB's complete data, so it is not an import gap.

Owner ruled 2026-08-02: leave the missing targets blank for now; do not backfill CA6.

## 2026-08-06 — quantified for Anti Infective, and STILL not fixed

Re-verified live against production (`ozucdzovmcqvepbozvqf`). `phx_monthly_closing_direct('Anti
Infective','2026-07')` returns only **CA, D1, UE** — 1,150 units / 93,554.00 EGP from a single
validated batch `1f699277-d448-465a-8d6b-0d8db39f5751` (imported 2026-08-02), 5 rows in
`source_of_sales_fact_rollup`. **D2 and AB have zero direct rows.** The hardcoded one-off list
`src/lib/sales/july-2026-direct-orders.ts` matches that DB total exactly, so the workbook is
faithful — **the import itself is short, not the export.**

Against the owner's manual sheet, Anti Infective July direct is **2,120 units / 149,288.50 EGP**.
Missing from Phoenix: **1,020 units / 65,896 EGP** — Dakahlia 1 (SA 100), Dakahlia 2 (RO 100),
Dakahlia 3 (RO 300 + SA 120), Port Said-Domiat (RO 100 + SA 100), Behira 2 (RO 200). The manual is
wrong the other way on three: a 4th KFS-1 Saginkgo deal it omits (6,984), a Minia 2 Saginkgo deal
mis-keyed as Royafloxacin (3,637.50), and a Cairo East 2 deal priced 55.20 instead of 50.60 (460).

🔴 **`direct_order_requests` is NOT the source** — it holds 14 rows total, all with `sales_month`
NULL, and none of July's. Direct flows in through the SoS import (`is_direct`), so do not "check the
direct orders module" to audit a closing.

Also found: the workbook's **`Summary & Insights` tab reports retail only** (462,905.55 / 4,897 u)
while the `Closing Matrix` master is retail + direct (556,459.55 / 6,047 u). `Rankings & Mix` and
`Distributor Comparison` are retail-only too. Reading the Summary tab as "the month" understates the
line by the whole direct channel.

Related: [[railway-merge-is-the-production-deploy]] · [[sos-analytics-excludes-confidential-5x-gap]]
