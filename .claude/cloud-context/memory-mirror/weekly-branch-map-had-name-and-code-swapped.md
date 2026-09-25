---
name: weekly-branch-map-had-name-and-code-swapped
description: "26 Ibnsina stock mapping rows held the branch NAME as the key and ANOTHER branch's code as the name, putting 20 branches in the wrong region; fixed 2026-08-27"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-08-27T00:20:35.942Z
---

**The owner spotted this himself, in his own words: "branches their codes are placed instead of
name and name instead of code — if fixed will fix many mapping." He was right.**

In `weekly_sales_branch_region_map`, 26 **Ibnsina (`IS`), `source_file_type = 'stock'`** rows held
the branch NAME in `raw_branch` (the key) and a bare NUMBER in `branch_header_raw` (the name). The
number was not that branch's own code — it was **another branch's**: Kafr El Sheikh carried Ain
Shams' 70, Ain Shams carried Ismailia's 11, Aswan carried Alexandria Falaky's 45. The two columns
of the uploaded template were filled shifted against each other, and **the region was then chosen
to follow that wrong code**, so 20 of the 26 sat in the wrong region — Aswan in Alex-BHR, Luxor in
Delta 1, Kafr El Sheikh in Cairo, Minya in Delta 1, Sohag in Delta 2.

**How to detect it** — classify the two columns by SHAPE, per distributor, rather than eyeballing
rows. `raw_branch ~ '^[0-9A-Za-z._/-]{1,8}$'` is code-like; anything longer or Arabic is name-like.
The bucket that matters is **name-like key + code-like name = INVERTED**. Run it over the whole
table: on 2026-08-27 it read 25 inverted (all IS), 170 correct, 713 same-value-both-columns (PS,
POS and EG files carry no separate code column — that is normal, not a fault), 912 total.

**How to fix it without judgement.** The live sales rows already knew the answer: every one of the
26 branch names had **exactly one** distinct `region_code` across `weekly_sales_rows`, because the
sales side matched by the branch's own code and was never broken. So the correction is to copy the
region the real rows already carry, and set `branch_header_raw = raw_branch`. Never hand the owner
a classification sheet for this — see [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]]
for his standing rule about depot names.

Backup of the pre-fix rows: `zz_backup_is_stock_branch_map_20260827` — and remember
[[ad-hoc-backup-tables-are-anon-readable]].

**The symptom that reaches the owner is NOT "wrong region" — it is money spread too thin.** The
weekly split reads `branch_header_raw || raw_branch` as the branch NAME
([[weekly-anti-infective-ue-is-95pct-of-all-unmapped-value]]). A bare number names no place, so the
branch fell back to its REGION and its value spread evenly over every area in it. Aswan's depot was
landing on **fourteen** areas. Reports were still correct — the fact rows carried the right region
— but the mapping screen lied and the next stock upload would have taken the wrong one.

## The second half: an ENGLISH depot name named no place either (#2439)

A distributor never writes a brick verbatim. The brick is `قليوب`, the depot is "Kalioub Branch".
Eight such names were unreadable and spreading across their whole region. Added to `AREA_SYNONYMS`
in `src/lib/sales/weekly/governorates.ts`: `ain shams`→CA3, `kalioub`→D11, `shbein el kom`→D12,
`fakous`→D25, `suiz`→OT2, `bani swif`→UE9, `maryoutia`→GZ4.

**Every target area was read out of `source_of_sales_bricks`, never from a map of Egypt** — the
brick table outranks any geography you could reason from
([[address-matching-beats-paid-ai-and-geocoding-hurts]]). Two traps found doing it, both live:

- **`شبين` is TWO different towns.** شبين الكوم is Menoufia (D12); **شبين القناطر is Qalyubia
  (D11)**. Register the WHOLE phrase. The bare `شبين` entry in `WEEKLY_EXTRA_ALIASES` already reads
  Menoufia for both, which is wrong for القناطر — do not copy that shortcut.
- **`سويس` is also a street in CAIRO.** `جسر السويس` files under CA3. Suez was therefore registered
  in **English only** (`suiz`), never in Arabic.

**A region reading's printed percentages do NOT sum to 100.** Seven equal seats print as `14.29%`
each and the strings add to `100.03`. The sheet is rounded on purpose — conservation is a property
of the WEIGHTS, so assert on those. Summing what the sheet prints is not the conservation test.
