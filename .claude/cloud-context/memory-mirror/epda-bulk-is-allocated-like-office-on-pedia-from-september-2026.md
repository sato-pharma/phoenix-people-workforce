---
name: epda-bulk-is-allocated-like-office-on-pedia-from-september-2026
description: From the September 2026 closing EPDA-BULK is spread across Pedia areas by each area's share of the OTHER distributors' sales, exactly as Office is on CNS — implemented as a read-time NET on the city split's rails, never a rewrite of the uploaded rows.
metadata:
  type: project
---

Owner instruction, 2026-10-09 (spoken): "Starting from September closing, the EPDA bulk will be
distributed and calculated exactly as Office, but in line Pedia — you will get the total sales
contribution of the other distributors over the total sales, get the contribution of every one, and
based on this distribute the same contribution from EPDA bulk."

So EPDA-BULK (`EP-BK`) becomes an ALLOCATED channel on **Pedia**, run on the locked Office rule's
arithmetic: one blended share per AREA = that area's share of the line's non-`EP-BK`, non-direct
VALUE (units × master factory price), the same share applied to every product, then pro-rata onto the
area's bricks. Earlier months keep the as-invoiced geography — his words start it at **2026-09**, and
July and August are published anyway.

**Why:** the bulk book invoices warehouses, so the invoice address is where the goods were BOUGHT,
never where they were sold — the same defect the Office channel and the city rule exist to answer.
A wholesale month therefore paid 2 areas and starved 37 (June 2026: all 30 Pedia packs sat in AB1
and one other area).

**How to apply:** `src/lib/sales/closing-bulk-allocation.ts` at CLOSING READ time, never at upload,
so a batch re-mapped after the bulk file cannot leave the spread stale (the measured Office defect —
3.39% of August's CNS Office units, [[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]]).
🔴 **It cannot import `buildOfficeAreaWeights`** — office-allocation → monthly-distributor-import →
attribution-store-split-refresh → attribution-store-split-net is a cycle back to the caller — so the
arithmetic is duplicated and `tests/closing-bulk-allocation.test.ts` pins it equal to the locked
builder to 1e-9 instead. 🔴 **It is a NET folded onto the city split's existing rails** (matrix
write-back + `au.monthly_store_split_net`), never substituted detail rows: the Total sheet is proven
to be Data SUMIFS + net + direct, so allocated rows PLUS a net would move the money twice. And the
bulk rows are carved out of `isSplitEligible` from September, or the city rule moves the same units
first. Settled by him the same day: the bulk sector keeps arriving as its own `EP-BK` upload
("ساتو قطاع جملة"), so nothing classifies a merged sheet
([[epda-bulk-merged-into-epda-pharmacies-from-july-2026]]); Pedia is the only line; the allocated
money keeps the label **EPDA-BULK**. Office stays CNS-only by `OFFICE_CHANNEL_LINES` and this rule
Pedia-only by `BULK_ALLOCATION_LINES` — keep the two lists apart. Head Office Lacto Basic
(LA003/LA004) is untracked and confidential and is left exactly as invoiced.
