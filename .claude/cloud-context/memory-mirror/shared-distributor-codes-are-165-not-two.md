---
name: shared-distributor-codes-are-165-not-two
description: "Only EPDA-Pharmacies shares distributor codes — 176 of them carry two pharmacies inside one month, Feb-Sep 2026 — but the number that matters is the rows DISAGREEING with the map (11,419.20 EGP over 27 rows, Feb-Aug), not the earlier 55,300.05 exposed population"
metadata:
  node_type: memory
  type: project
---

Measured on production over `source_of_sales_import_rows`, all periods present (**2026-01 … 2026-09
— there is no October sheet in the system**), folding names (lowercase, `ى→ي`, `ة→ه`, hamza forms to
`ا`, strip everything non-alphanumeric).

**Three tests. Only the third one measures the error.**

| Test | Result | What it actually finds |
| --- | --- | --- |
| 2+ folded names **anywhere** across Jan–Sep | **666** codes (PS 316, EP-PHS 299, IS 21, EG 21, IS-S 5, EP-BK 3, SF 1) | mostly a shop RENAMED or re-spelled between months |
| 2+ folded names **inside one month** | **176 codes / 289 code-periods — every one EP-PHS** | two pharmacies that both sold that month |
| row's folded name ≠ its ACTIVE map row's folded name | **27 rows / 11,419.20 EGP** on tracked lines | the rows genuinely credited to the wrong pharmacy's area |

🔴 **ONLY EPDA-PHARMACIES SHARES CODES**, and it runs back to **February 2026** — nothing here came
from a new import. Shape, verbatim: `22197955` = حرية الصواف - الحوامدية **and** هانى صلاح - شبرا
الخيمة, both every month from February.

🔴 **MY EARLIER "49 CODES / 110 ROWS / 55,300.05 EGP" WAS OVERSTATED — DO NOT QUOTE IT.** Re-measured
2026-10-10 straight after the September splits: tracked-line rows sitting under a within-month shared
code are **46 rows / 19,818.00 EGP / 27 codes** (Feb 5,683.05 · Mar 6,495.75 · Apr 4,113.45 · Jun
603.45 · Jul 2,271.15 · Aug 651.15 · **Sep 0**), and under those codes the money is overwhelmingly
**Head Office — 1,092 rows / 1,016,600.72 EGP**, against Pedia 37 rows / 18,090.00 and Anti Infective
9 rows / 1,728.00. Head Office reports nowhere, so the exposed-population figure always flatters the
problem: **the error is the third test, 11,419.20 EGP, and every one of those rows is in a locked,
published Feb–Aug month awaiting his unlock.**

🔴 **PS DOES NOT SHARE CODES — I reported that it did, and it was wrong.** Every PS pair inspected is
one pharmacy wearing a decoration: `مستشفى الانسانية - اسيوط` vs `صيدلية مستشفى الانسانية - اسيو`
(a `صيدلية` prefix plus the 30-character truncation), `حنان جيمى مصر الجديدة` ± `اجل` (credit),
`ايمن احمد شلتوت/ميت خاقان` ± `مغلق` (closed), `شيرين شعان حماد` → `شيرين شعبان حماد` (typo fixed),
`رانيا جمال …` → `تفتيش رانيا جمال …` (inspection). The earlier "PS 22 codes / 36,508.04 EGP" came
from counting names across three months, which cannot distinguish a renamed shop from two shops.
And an area-spanning test finds none of them: every row under a code inherits the brick/area of its
ONE map row.

**Why it matters:** for each shared code, every pharmacy on it is credited to one area — the map's —
so the ones that do not belong there have their sales reported in the wrong rep's area with nothing
flagging it. July 2026 did exactly that to `22198955`. **Count distinct folded names per
`(distributor_code, client_code, invoice_period)`, never across periods — and then run the map
comparison, because a month in which only the intruder sold shows ONE name**
([[septembers-epda-code-splits-are-complete]] — that blind spot hid three of September's fifteen).

**How to apply:** [[a-code-split-gives-the-new-code-to-the-unlocked-pharmacy]] for the procedure,
[[a-shared-codes-address-is-looked-up-by-code]] before trusting an address as brick evidence, and
`the-two-sales-rollups-store-units-only-never-value` for comparing layers. September is **done**;
Feb–Aug tracked rows sit in published, locked closings, so those splits need his unlock. Related:
[[epda-pharmacies-22199672-was-split-into-two-pharmacies]].
