---
name: qena-1-and-2-both-cover-qena-city
description: "The owner's \"Qena 1 is the city, Qena 2 is the markaz\" rule does not reproduce his own sheet — both areas hold Qena-city shops, so no address rule can split them"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T17:55:35.520Z
---

The owner gave the same rule for Qena on 2026-08-10 that he gave for Sohag: *"qena 1 is the city,
qena 2 is the markaz"*. **It works for Sohag and does NOT work for Qena.** Measured against his own
`Jul- 2026 Sales Closing ( CNS Line ) Final .xlsx` Data tab before anything was applied:

- Reading it as address text (markaz named → that markaz's brick) moves **zero** area units. Phoenix
  already agreed with the address wherever a markaz was written.
- Reading it as brick geography (only `B209-1 مدينة قنا` is Qena 1, all 13 other Qena bricks →
  Qena 2) cuts the error 751 → 259, but **contradicts his sheet on 505 units** — he files
  قوص، نجع حمادى، دشنا، أبو طشت، فرشوط as **Qena 1**, and every one of those is a markaz.
- Copying his sheet shop by shop scores an error of 1. His sheet is self-consistent; the *rule* is not.

**Why no address rule can work:** 122 shops (375 units) that he files as **Qena 2** sit in Phoenix's
fallback city brick with plain **Qena city** addresses — ش 23 يوليو، كورنيش النيل، ميدان سيدى
عبدالرحيم، ش الجمهورية، مساكن عثمان. The *same street* appears on both sides of his own sheet
(ش عبد المنعم رياض: 4 shops Qena 1 / 2 shops Qena 2; ش المحطة 7/3; ش الجمهورية 8/3). Qena 1 and
Qena 2 are two reps splitting one city by customer list, not by geography.

What was applied instead (109 customers, source `owner-ruling-qena-markaz-address-2026-08-10`):
the rule with the **asymmetry** that an address naming a markaz is positive evidence, while an
address naming nothing is UNKNOWN and leaves Phoenix untouched. Applying it symmetrically would have
dragged 116 units *out* of Qena 2 into Qena 1 and made the gap worse — e.g. `420214 الصفوة للادوية`
(60 units, address «حوض العبيد») is correctly in نقادة today and his sheet agrees.

**Why:** the same sentence from him produced a good result on one area and a harmful one on the
next; a rule has to be measured against his sheet before it is applied, never applied because he
said it. See [[cns-closing-35-areas-are-the-organogram-non-ot]] for the area list and
[[sos-duplicate-brick-names-are-decoys]] for the other place brick names mislead.

**How to apply:** only his sheet's per-shop area can settle these — there is no derivable rule. He
approved "yes copy my sheet" on 2026-08-10, applied as 112 customers under source
`owner-ruling-qena-copy-his-sheet-2026-08-10`. **The Qena SHOP side is now exact** (Qena 1: 1,003 vs
1,003; Qena 2: 568 vs 567) and the whole residual gap is Office spread.

**That copy required NEW master geography — brick `B209B-1 مدينة قنا - قنا 2` in new block `B209B`
(UE8/UE).** It is not cosmetic: `deriveHierarchy` in
[resolvers.ts](src/lib/sales/normalizer/resolvers.ts) returns `b.areaCode` **from the brick**, and
`source_of_sales_customer_map.area_code` is never read for the resolution — so setting the map's
area alone would have been silently reverted by the next upload. And
`source_of_sales_bricks_block_hierarchy_fk` FKs `(block_code, area_code, region_code)` to the block,
so a UE8 brick cannot live in a UE7 block. Any future "this customer belongs to a different area"
ruling that has no brick in the target area needs the same two inserts.

Two shops (`374324`, `445771`, 1 unit each) have قفط in the address but sit in Qena 1 in his sheet;
his sheet won, so their brick is now `B209-1 مدينة قنا` — deliberate, not a mapping error.
