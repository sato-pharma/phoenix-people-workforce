---
name: el-qema-three-bands-plus-upper-egypt
description: "LIVE El Qema rule — the THREE BANDS (200 / 201-699 / 700+; flat band moved from 1000 to 700 on 2026-09-10), the صعيد redistribution, and the LEAD GUARANTEE that puts Qalubeya, Tanta and Mahalla on top of the contribution table by 2%. Owner 2026-09-09 evening. He stated the lead as an outcome and rejected it being reported instead of enforced."
metadata: 
  node_type: memory
  type: project
  originSessionId: d4c0f7f1-f648-4233-aaf3-01d653c69719
  modified: 2026-09-15T13:40:15.428Z
---

Owner, 2026-09-09 evening: *"remove any current rule and implement those"*, then *"start it now"*.
The priority ladder and the 75/25 are gone.

## The bands — per warehouse, per PRODUCT, on the month total

1. **Up to 200 packs** — the governorate's reps only.
2. **201 to 699** — 50% governorate, 50% over the rest of the country. **Qalubeya means Qalubeya +
   Cairo**, and he named no weighting inside it, so it divides EVENLY.
3. **700 and above** — evenly over the whole country, **never Others**.

⚠ **The flat band moved from 1,000 to 700 on 2026-09-10** (`WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY = 700`
in `src/lib/sales/store-sales-city-split.ts`, verified on `origin/main` 2026-09-15; AGENTS.md §4
agrees). This file said 201–999 / 1,000+ until the 2026-09-15 config audit.

## The صعيد pass, and the three things a reader gets wrong

- 🔴 **It TAKES money out of Upper Egypt** — nine areas held the pool and share half of it after.
- 🔴 **"الجمهورية", not "باقي الجمهورية"** — the REPUBLIC, so a صعيد area is in both halves.
- 🔴 **It runs in EVERY band, band 1 included.**

## 🔴 Upper Egypt cannot be read from August's region codes

Fayoum (GZ6) and Beni Suef (UE9) sit in the **GIZA** region until 2026-09-01, and he named both by
name as صعيد. `UPPER_EGYPT_AREAS` carries the August golden rule's UE-1 + UE-2 membership, less
Others. See [[el-qema-never-appears-in-closing-details]], which is unaffected.

## 🔒 THE LEAD GUARANTEE — and the lesson that cost a round trip

> مع الحفاظ على منطقة القليوبية الاولى و الثانية طنطا لابد ان يكونوا اكبر نسبة contribution

A LADDER, not a tie: **Qalubeya (D11) first**, then **Tanta (D14) and Mahalla (D15) level behind
it**, then the field — one **2%** step per tier, everyone else paying pro rata.

🔴 **"Qalubeya number 1" was a SECOND ruling.** The first build put all three on one figure, which
met *"they must be the biggest contribution"* but left the order to the sort, so Qalubeya read third
of three at the same percentage. **A tie is not a rank.**

🔴 **THE FIRST BUILD MEASURED THE GAP AND REPORTED IT INSTEAD OF CLOSING IT, AND HE REJECTED THAT IN
THOSE WORDS** — *"didn't I tell the fuck out of you that those three areas Tanta, Mahalla and
Al-Yubayya should be the biggest contribution in all areas"*. **"لابد" is a requirement.** An outcome
the owner states is a rule to enforce, not a finding to hand back. He had already said it once inside
the ruling, so it was said twice before it was built.

**Why it cannot live in the per-row plan.** A plan is one customer's sale; contribution is the month.
A per-row floor is infeasible on a small plan — a 150-pack Alexandria sale divides across three
areas, and no three OTHER areas can each exceed the largest of three shares of one. So it runs once
over the finished landing, per line and product.

**The step is a FIXED POINT.** Paying the three shrinks the field they must beat, so taking 2% of the
field as it stood before overshoots — measured, it landed them 5.4% clear.

⚠ **The Store Split Detail sheet and the import preview do NOT show it**, correctly: a month-level
adjustment is not a property of one sale. The Matrix, the attribution net and the closing carry it.

## Measured, August 2026 Pedia

8,768 packs and 2,367,360 EGP land exactly over 38 areas, **no area negative**. The three named areas
finish on **3.599%** (Qalubeya) and **3.528%** (Tanta, Mahalla), Alexandria next at 3.459%. Without the guarantee Alexandria led on 3.565%
and Qalubeya ranked 22nd — **its own 6,644 packs buy it nothing, because every one is band 3.**

## 🔴 A DISPLAY FOLD CAN CORRUPT THE ATTRIBUTION NET — found 2026-09-09, fixed

Pedia shows Fayoum (GZ6) and Beni Suef (UE9) as ONE row, and `loadMonthlyClosingDetails` delivers
that by rewriting a Beni Suef row's `sheetAreaCode` to GZ6. Inside the CLOSING that is fine — the
matrix folds the same pair. **`au.monthly_attribution_rollup` does NOT fold**, so a net built from
folded rows charges Beni Suef's whole book OUT of Fayoum while attribution credits Beni Suef its own
base. **Fayoum landed at −24.95 units on a base of 64.**

It PREDATES this rule and merely stayed positive (−29.44 under the ladder). Fixed with
`keepMergedAreasApart`, passed by exactly the two attribution-net builders, pinned by
`tests/merged-area-attribution.test.ts`. **Any future merged pair will do the same thing** — a fold
made for a screen must never reach a net that keys on the real area.
