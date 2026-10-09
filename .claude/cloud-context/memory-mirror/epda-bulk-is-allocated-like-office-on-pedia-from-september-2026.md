---
name: epda-bulk-is-allocated-like-office-on-pedia-from-september-2026
description: "From the September 2026 closing EPDA-BULK's IVYRONC (`IV001`) only — he narrowed it to one product the same evening — is spread across Pedia areas by each area's share of the OTHER distributors' sales, exactly as Office is on CNS; every other bulk product keeps normal mapping, is not a weight and still takes the city rule. A read-time NET on the city split's rails, never a rewrite of the uploaded rows."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T16:07:01.192Z
---

Owner instruction, 2026-10-09 (spoken): "Starting from September closing, the EPDA bulk will be
distributed and calculated exactly as Office, but in line Pedia — you will get the total sales
contribution of the other distributors over the total sales, get the contribution of every one, and
based on this distribute the same contribution from EPDA bulk."

🔴 **AND HE NARROWED IT TO ONE PRODUCT THE SAME EVENING, typed: "IN EPDA BULK ONLY IVYRONC WILL BE
CONTRIBUTION ANY OTHER PRODUCT NORMAL MAPPING."** So the allocation is `EP-BK` **× Pedia × `IV001`**
— the live master holds exactly one Ivyronc code (family `IV`, Pedia, active), and a second
concentration must be added to `BULK_ALLOCATION_PRODUCT_CODES` because a detail row carries its code,
never its family. **"Normal mapping" is three things:** another bulk product keeps its invoiced area,
is **not a weight** (the bulk sector is not one of the "other distributors" whichever product it
sold — into the base it would help decide where its own Ivyronc goes), and **stays split-eligible**,
so a bulk wholesaler in a multi-area city still takes the city rule. Freezing those rows is the
inverted defect. 🔴 **On the live book this now moves NOTHING: no `EP-BK` batch has ever carried
Ivyronc** (2026-02/03/04/06 = Lacto Basic on Head Office + 599 packs of Lacto Advanced on Pedia), so
a zero is the rule working and the 599 packs are back on normal mapping.

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
