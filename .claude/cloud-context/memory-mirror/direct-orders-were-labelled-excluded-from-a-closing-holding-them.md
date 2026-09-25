---
name: direct-orders-were-labelled-excluded-from-a-closing-holding-them
description: "Monthly Closing Details read \"In closing 0.00\" beside 290,387.57 EGP of booked direct orders, because its headline came from includedInClosing (= \"feeds the distributor matrix\"), and direct rows were re-priced at factory price in every month but 2026-07"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-08-26T08:08:15.629Z
---

**"The finance manager chooses the sales month and the sales don't sync in monthly closing"
(owner, 2026-08-25) was never a sync failure.** The data layer was correct the whole time — 20
approved direct orders booked to 2026-08, batch `validated`, `source_of_sales_fact_rollup` tying to
the cent, and the Closing **Matrix** already showing the money. Two display defects on the
**Details** panel, the Finance Manager's only closing door:

**A — the label.** `reconciliation.includedInClosing` means *"this row feeds the distributor
matrix"*, not *"this row is in the closing"*. Direct rows are injected separately by
`injectDirectIntoMatrix` and are inside `combined.grandTotal`, so Details showed:

| Line, 2026-08 | "In closing" | "Direct (excluded)" |
| --- | --- | --- |
| Anti Infective | **0.00** (0 rows) | 29,947.50 (7 rows) |
| Pedia | **0.00** (0 rows) | 274,488.75 (15 rows) |

The 0.00 was *arithmetically true* — 2026-08 holds only direct rows, zero distributor sell-out — which
is exactly why it survived: it looked like a data outage, not a mislabel.

**B — the money.** Direct value was recomputed as `effectiveUnits x factoryPrice` in every month
except 2026-07. Measured on production (`ozucdzovmcqvepbozvqf`), 2026-08:

| | as struck | re-priced | error |
| --- | --- | --- | --- |
| Pedia | 258,858.67 | 274,488.75 | **+15,630.08** |
| Anti Infective | 31,528.90 | 29,947.50 | **−1,581.40** |
| both | **290,387.57** | 304,436.25 | **+14,048.68** |

**The error runs in OPPOSITE directions per line, so no correction factor exists** — it has to be
the stored value or nothing. That also means an eyeball check of one line can look plausible.

## How it was fixed — and the trap in fixing it

**`includedInClosing` was NOT flipped for direct rows.** It is load-bearing in four places —
`monthly-closing-export.ts` (the Data/Total SUMIFS bridge), `rebuildMatrixFromRows`,
`store-sales-city-split.ts`, `monthly-closing-comparison.ts` — and flipping it **double-counts
direct**, because the matrix already injects them. A separate predicate
`countsInClosingHeadline` (`src/lib/sales/closing-headline.ts`) plus a
`reconciliation.closingHeadline` total were added instead.

That predicate lives in its **own leaf module on purpose**: `closing-details-panel.tsx` is
`"use client"` and needs it as a *value* import, while `monthly-closing-details.ts` reaches
`getSupabaseAdmin` — importing the predicate from there drags the service-role client into the
browser bundle. Value import from the leaf, `import type` from the details module. See
[[a-narrowed-select-disarms-every-gate-downstream-of-it]] for the sibling shape.

## The judgement call the owner should re-confirm

The stored-value rule was scoped to **July 2026 only** by his 2026-08-06 ruling. PR #2412
**widened it to every month**, reasoning that [[direct-order-pricing-rule-locked]] already bans
factory price in the Direct Orders module *for anything*, and a rule true in one month only is a
bug waiting for its month. **Reversal is free while it stays cheap:** only 2026-07 (already correct)
and 2026-08 (not yet published) contain direct rows. If more months accumulate direct orders, that
stops being true — ask him before then.

**Why:** this cost a full session to find because every layer *underneath* the panel was healthy,
so "not syncing" pointed at the import/rollup path, which was never the problem. The tell was that
the excluded card held the exact right money.

**How to apply:** when a closing surface disagrees with the Matrix, **check the label semantics
before the pipeline** — compare `includedInClosing` against `combined.grandTotal` first. And never
read a 0.00 on a month as an outage without checking whether that month has any distributor rows at
all. Related: [[sos-monthly-closing-is-the-only-sales-truth]],
[[direct-order-sales-month-is-a-finance-step-not-a-bug]],
[[one-direct-order-makes-a-month-look-uploaded]].
