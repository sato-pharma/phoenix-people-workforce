---
name: sos-system-still-trained-on-old-bricks
description: "The whole SoS stack — normalizer aliases, brick centroids, customer map, fact rollup — still points at the pre-2026-07-27 bricks, not the 627-brick master"
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-28T12:04:13.685Z
---

Owner flagged 2026-07-28: "sos is trained on old bricks, needs update." Measured — he is right,
and it is system-wide, not just the normalizer.

Live geography: **1,140 brick rows** = 627 in `Master of Master.xlsx` + **409 active but NOT in
the master** + 104 inactive.

| What | Points outside the master |
|---|---|
| `source_of_sales_customer_map` | 30,919 of 49,712 — **62.2%** |
| `source_of_sales_fact_rollup` rows | 114,036 of 158,258 — **72.1%** |
| `source_of_sales_fact_rollup` UNITS | 1,126,019 of 1,441,262 — **78.1%** |
| `source_of_sales_territory_aliases` | 323 of 445 — **72.6%** |
| `geo_locations` brick centroids | 512 of 772 — **66.3%** |

Also: `source_of_sales_import_rows` has 39,017 rows on *inactive* bricks and
`source_of_sales_customer_directory_rollup` 25,499 (both understate the true figure, which
includes the 409 active-but-superseded bricks).

## Owner-validated matching rules (MCQ review, 2026-07-28) — 9 judged, 8 correct

Rules the owner CONFIRMED, keep them:
- **A customer's own ADDRESS beats a third-party geocoded district**, even when the address
  points into another area — and when it does, the row is **demoted to review, never
  auto-applied**. Found via «أرض الجزيرة خلف بنك مصر-زفتى» placed on كفر الزيات because the
  geocode said so; 594 rows / 47,172 units had the same fault, 432 were live and were restored.
- **Name-only matching is sound** when the name carries a real place («مكه فارما - اسيوط»,
  47,156 units → مدينة أسيوط, confirmed correct).
- **A street beats a nearby square** («5ش الجلاء رمسيس» → ش الجلاء, not ميدان رمسيس).
- **A generic street name must not beat a city** («ش احمد سلطان من ش الجيش -الزقازيق» →
  الزقازيق, not the Cairo ش الجيش brick).
- **An ambiguous distributor territory label is NOT evidence.** Labels naming two places at
  once (`SUEZ /S SINAI`, `PORT SAID /N SINAI`, `Ismailia-Suez`) must never auto-resolve —
  send the customer to the rep. 55 rows affected, 13 were live and were restored.
- Distributors may book a customer under a neighbouring territory (owner confirmed a Sharm
  El-Sheikh customer at «جويا مول» belongs to **Suez** for this distributor) — so do NOT
  "correct" a territory on geography alone.

**Two traps hit while fixing the geocode rule:** a pure-address tier alone did nothing because
the tier is *area-scoped*; and a 5-character minimum on full brick names silently excluded
`زفتي` — **53 real bricks have a 4-character name** (`إدكو`, `رشيد`, `جليم`, `أبيس`). Use ≥4.

## 🔴 ROLLED BACK 2026-07-28 — the remap was 20% WRONG, `customer_map` restored

A 40-row owner check on the LIVE applied rows came back **8 wrong = 20%** (95% CI ≈ 9–36%,
≈4,300 of 21,715 rows). All 21,715 rows restored from the snapshot; verified 0 rows differ from
it and 0 carry `master-remap-2026-07-28`. Table is back to 430 bricks in use.

**Do not trust internal consistency as an accuracy measure.** The twin-address proxy said 4.4%
and my own 12-row in-chat sample said 0% — the real rate was 20%. Only an owner-judged random
sample found it. Ask for one BEFORE writing, not after.

### Rules that took the measured error 20% → 2.5% (all validated on the owner's 65 judgements)

- **RULE G — the FIRST place named wins, not the longest.** Only among matches on a brick's
  FULL name; among fragments longest still wins (an early fragment `الحصه` must not beat a
  later `كفر الزيات`).
- **RULE H2 — an area's CAPITAL brick loses to a town named in the CUSTOMER NAME.**
  `مدينة سوهاج`/`إمبابه` are what an address falls back to when it states only the governorate.
  Scope it tightly: fires only when the winner is a capital AND the name offers an alternative.
  The blanket version (demote every capital always) is WRONG — it moved `المحله الكبرى`, whose
  own address named it directly.
- **OWNER RULINGS layer** (`scratchpad/owner_rulings.json`) — a place the owner settles by name,
  pointing at an EXISTING brick instead of creating one (`الهضبة الوسطى → B31-55 المقطم`,
  fixed all 16 such customers). Checked before every tier so a ruling always wins. Add a line
  per ruling; do not invent bricks for these.
- **RULE SMALL — the owner's governing principle: "U ALWAYS MAP ON THE SMALLEST BRICK
  AVAILABLE."** Two parts, and both guards matter:
  1. **Rank demotion** — an area's catch-all capital loses to any smaller brick, but ONLY when
     every surviving candidate matched its brick's FULL name. Applied on *fragment* matches it
     broke `المحله الكبرى`→`محلة حسن` and `شبين القناطر`→`قليوب`. Smaller is not evidence when
     nothing matched in full.
  2. **Containment** — when one brick name word-contains another, the LONGER is the smaller
     place (`حدائق حلوان` ⊂ `حلوان`, `دمياط الجديد` ⊂ `دمياط`). Measured: 20 of the master's 21
     real containment pairs run that way; `دمنهور شبراخيت` is the lone two-town compound and
     RULE G already handles it, so no compound test is needed.
     **Compare word-wise, never as a substring** — as raw text `اجا` sits inside `سفاجا` and
     `رشيد` inside `خورشيد`, which are not places containing places. 6 of the 27 apparent pairs
     are this artefact.
  Do NOT rank by word count: most Egyptian place names ARE two words (`شبين القناطر`,
  `كفر الشيخ`, `أبو حماد`), so "2+ meaty words = broad" wrongly demoted ordinary towns.
  Net effect: 32 customers move, all big→small.
- **GOVERNORATE GUARD** — a single-word phrase may match inside a token (Egyptian addresses glue
  words: `العامريةصحراوي`, `المعادىبملك` — **920 customers resolve only because of substring
  matching**, so do not require a word boundary), but not inside a *governorate* name:
  `منوف` fired inside `المنوفيه` and sent a Sadat City customer to Menouf. Require one
  occurrence outside `_GOVSET`. Costs 42 rows, fixes the whole class.
- **Owner extended the master to 629** — added `B182-77 دمنهور` (distinct from `دمنهور شبراخيت`)
  and `B207-32 دمياط الجديد`; they absorbed 517 and 90 customers that were on the wrong compound
  brick. File: `scratchpad/Master of Master (FIXED).xlsx`, integrity-checked (2 added, 0 removed,
  0 changed) before use.

Final: **6 of the owner's 8 corrections resolved, 0 regressions on the 57 he marked correct**
(`r_FINAL.json`, 37,010 customers on a master brick = 74.4%, 31,533 class `BRICK - resolved`).
The last one (`مسطرد`) has NO place in its address at all and rests on an `APPROXIMATE` Google
geocode — that is the floor for address-free rows, not a fixable rule.

### Self-check model (owner: "you check as me, only the non-confident come to me")

Score each resolved row on TWO independent things — **how** it was reached (full brick name vs
fragment, candidate count, whether a tie-break rule decided) and **who else agrees** (geocoded
district, twin address, live area, `MAPPING.xlsx`). Files: `scratchpad/confidence.py`,
`confidence.json`, `build_lowconf.py`.

- **Derive `full_name` from the ANSWER (`norm(brick_name) == norm(matched)`), never from a
  tier-1 evidence flag** — tier 1 is one of several resolve paths, so reading the flag marked
  every block/area/cross-area row a "fragment" and dumped **5,108 solid rows into LOW**.
- Bands: HIGH 16,747 · MEDIUM 9,687 · LOW 5,077. Both known errors land in LOW (15% in-band);
  HIGH+MEDIUM hold 52 owner confirmations with 0 errors. **2 known errors is far too few to
  certify the score** — say so rather than implying it is validated.
- **`MAPPING.xlsx` brick IDs are the strongest witness**: 229/230 agreement, and the single
  difference is an error in that old file (an Alexandria customer on the Cairo brick
  `B16-26 ش الجيش`; `شارع الجيش` in Alexandria is a different street).
- Hand-checked: 30/30 HIGH correct; 24 MEDIUM found 2 wrong, both one rule bug.

### Two more matching rules, found by hand-reading (2026-07-28)

- **A place with a STREET head-word in front of it is a street NAMED AFTER it, not the place.**
  `شبين الكوم - ش دنشواى` is Danshway Street *inside* Shibin El-Kom. Drop street-prefixed
  candidates only when a real place also matched. Corrected **271 customers**
  (`ش سليم الاول الزيتون`→الزيتون, `ش البيطاش العجمي`→العجمى, `ش راس التين الجمرك`→الجمرك).
- **INFLECTION guard** — reject a substring match when what follows is an Arabic inflection
  ending `{ي، يه، وي، ويه، اوي، اويه، ه، ا، ات، ين، يين، يا}`: صدفا inside الصدفاوى (a family
  name), جرجا inside الجرجاوية, منوف inside المنوفيه, الصف inside الصفا. **Do NOT reject on
  remainder length** — `بم` (بملك) and `ش` (شارع) are glued on constantly and a ≥4-char rule
  threw away 178 good rows (`الصفبم رفعت`, `الزيتونش الجيش`, `الدخيلةج`).
- **`شارع` must normalise to `ش`** — 37 bricks are named with the abbreviation while addresses
  spell it out, so `شارع الجيش` could never equal the brick `ش الجيش`. +34 resolved, and it
  also lets `المعادى`→`ش الجزائر`, `العباسيه`→`ش رمسيس` find the smaller street brick.

## 🟢 `Desktop\Raw` = the six months of ORIGINAL distributor files (audited 2026-07-28)

`C:\Users\satoh\OneDrive\Desktop\Raw` — 100 files / 54 MB, `sato 1-2026`…`sato 6-2026`, one
folder per month, one workbook per distributor. **223,669 rows, 47,933 distinct customers,
1,382 territory labels.** Extractor: `scratchpad/raw_extract.py` → `raw_rows.json`.

Join to `customer_map` on `(dist, code-with-leading-zeros-stripped)`: **IS 99.8% · PS 88.5% ·
RM 92% · SF 91% · MC 95% · EP 100% · EG 0%** (EG codes are a different format — 50 customers,
ignore).

| what each distributor calls geography | column |
|---|---|
| Overseas (PS) | `Sal. Dist. Desc.` — clean Arabic place names, 702 labels, 172k rows |
| Ibn Sina (IS) | English `REGION CITY` pairs (`BEHERA II KAFR ELDAWAR`), + `old brick` (6-digit legacy id) |
| EPDA | `TerritoryName` · Ramco `منطقة` · Sofico `ZipCodeName`/`bricks` · MEC `bricks` |
| PAS DataHub report | `Brick / Governorate Name / Territory Name / Brick Name` |

⚠️ **`EG` labels are BRANCH names (`فرع دمياط`) = the warehouse shipped FROM, never the
customer's location.** Excluded from all learning.
⚠️ The `brick`/`bricks` columns hold the **OLD 6-digit numbering** (`256601`), not master ids.

### Results of the Raw audit

- **+3,565 customers resolved** (31,511 → **35,076**); on a master brick **74.3% → 81.1%**;
  "no place in text" 5,868 → 2,440. **0 regressions** on the owner's 65 judgements.
  Gain came from Raw *names/addresses* for codes `customer_map` leaves blank —
  `RECOVERED=recovered_plus_raw.json` env var on `resolve_v11.py`.
- 🔴 **The resolver was pasting the distributor's TERRITORY LABEL into the text it matches on**
  (`nrec`/`nrec_addr` included `_rc['geo']`), and `hay_pure` — the FIRST tier — read it. So a
  routing code outranked the customer's own address. Raw amplified it from 6k to 41k codes and
  it broke 3 confirmed rows. **Fix: keep `geo` out of `nrec_addr` entirely and only in `nrec`,
  which feeds the last-resort haystack.** Removing it altogether is also wrong — 2 rows resolve
  by label alone.
- **Address truncation is in the DISTRIBUTORS' OWN FILES, not our import.** 14,085 customers
  (28%) have addresses cut at exactly 29–30 chars; Raw is capped the same way and recovers a
  usable tail for only 10. This is a hard accuracy ceiling — do not go looking for it again.
- **A territory is COARSER than a brick.** `اسيوط` spreads over مدينة أسيوط + الوليديه + الفتح.
  So a label may only ever target an **AREA**; a brick-level label alias would drag every
  customer in the territory onto its capital — the opposite of the smallest-brick rule.
  Learned label→area: **479 labels pin one area at ≥85%, covering 20,525 customers.**

### Normalizer: the right table is `source_of_sales_area_aliases`, and it is EMPTY

`source_of_sales_territory_aliases` = 798 active, **all `target_type='brick'`**.
`source_of_sales_area_aliases` (`alias, normalized_alias, area_code, region_code, active,
source_file`) has **0 rows and always has** — yet `crosswalks.ts:94` loads it and
`resolvers.ts:113` uses it. That is the correct home for territory labels.

Prepared: **256 safe aliases** (`scratchpad/alias_proposal_safe.json`,
`apply_area_aliases.mjs`) — the 465 learned minus 209 whose string is already a brick name or
brick alias (`بنها` as an *address word* means the brick; as a *label* it means area D11, and
the table cannot tell them apart). Safe set = glued spellings (`كفرالدوار`, `ابوقرقاص`),
numbered rep territories (`اكتوبر 6`, `امبابه 1`), Ibn Sina English (`domiat domiat`) —
vocabulary name-matching can never reach.

✅ **APPLIED to PRODUCTION 2026-07-28 on the owner's "run it"** — 256 rows, 40 areas, 7 regions,
all active; verified 0 orphan area/region codes, 0 blank aliases.
Rollback: `DELETE FROM source_of_sales_area_aliases WHERE source_file = 'Raw distributor files
2026-01..06';`

**Resolution order makes these rows safe** (`src/lib/sales/normalizer/resolvers.ts`): the
TERRITORY alias is consulted first (step 2, brick then area), and the AREA alias only on a miss
(step 3). So a brick-level alias always beats an area row — these can fill gaps but can never
make an existing mapping coarser. Only 2 of the 256 share a string with an active brick alias
(`الترعه البولاقيه`, `الخلفاوي`); both are inert for that reason.

## ✅ DUPLICATE-BRICK MERGE + owner rulings — applied 2026-07-28

**The 8,865 off-master customers were never 8,865 problems — they were ~14 duplicate bricks.**
Old bricks like `B139-13 سوهاج المدينة`, `B141-27 قنا`, `B7-64 مدينة نصر` are the SAME PLACES the
master already holds under different ids. **94% matched the master by name.** Diagnose by
brick, not by customer: count distinct old bricks per area first — UE6 had 682 customers on ONE
brick, CA2 had 426 on one.

Applied: **5 same-area merges (1,014 custs)** · **قنا+قوص → Qena 1 (708)** · **مدينة سوهاج →
Sohag1, طلخا+نبروه → Dakahlia 1 (994)**. Then `import_rows` remapped and all 89 batches rebuilt.
`fact 158,258 / 1,441,262.47` · `directory 149,488 / 1,229,492.47` · `import 1,442,905.17` ·
`customer_map 49,712` — **all identical before and after; brick agreement 100%.**

⚠️ **A merge is only "safe" if the customers' CURRENT area matches the target brick's area.**
طلخا/نبروه looked like simple duplicates but all 312 customers sat in D22 while the master puts
the bricks in D21 — that is an area move, not a merge. Always check per-customer area before
calling a merge mechanical.

⚠️ **No block in this system spans two areas (verified: 0).** So a master brick cannot be moved
between areas alone — it would create the first cross-area block and break block rollups. Move
the whole block, or add a new brick to the destination block.

**Owner arbitration rule (2026-07-28): when a conflict arises, `FINAL NEW (3).xlsx` wins, but
TELL HIM FIRST.** It overturned his own verbal ruling on Sohag City (he said Sohag2, sheet said
Sohag1; sheet won, at his instruction).

**Resulting area sizes — two worth watching:** `UE8 Qena 2` fell to **211 customers / 5,442
units** with 1 rep, and `D22 Dakahlia 2` to **18,930 units** against `D21`'s 124,804.

## ⛔ `FINAL NEW (3).xlsx` — REJECTED as a WHOLESALE master 2026-07-28 (still the conflict arbiter)

Handed over as "your source of truth", but it is an OLDER, COARSER generation. Owner's verdict
after seeing the diff: **"forget about it, keep us as we are."** Nothing from it was applied.

597 bricks / 42 areas vs the live 629 / 48. What applying it would have done:
- **Reversed the OT3 split** — drops OT4–OT10, re-adds OT3, sends Luxor (481 custs), Aswan (361),
  Hurgada (253), Esna (203), Kom Ombo (175), Edfu (110) back to the retired area.
- **Deleted 37 bricks holding 1,068 customers / 41,663 units**, including `B182-77 دمنهور` (494)
  and `B207-32 دمياط الجديد` (96) which the owner created that same morning, and
  `B205-13 الحي السابع` (only 20 customers but **22,337 units**).
- **Wiped the fine-grained bricks** that make "always the smallest brick" possible: the Nasr City
  street series (عباس العقاد, مصطفي النحاس, الحي السادس/السابع/الثامن/العاشر, التبه), the Gharbia
  villages (محله مرحوم, سبرباي, شبرا النمله…), the Mahalla villages (الهياتم, صفط تراب, محلة حسن…).
- **Renamed 10 bricks by spelling** — زفتي→زفته · ملوي→ملاوى · بسيون→باسيون · سنتريس→سانتاريس ·
  سمسطا→سامستا · طاميه→طميه · مشتول السوق→ماشتول · المراغة→المراغا · كفرالبطيخ→كفر بطيخ.
  These break address matching, since the resolver matches on exactly these strings.

⚠️ 4 of its 5 "new" bricks are only RE-NUMBERED (`B144-35 العشى`→`B175-1`, `B144-36 الصالحية`→
`B210-1`, `ش أحمد تيسير`/`ش الثوره` CA1→CA2). **Always diff a new master by brick NAME as well as
id, or a re-number reads as a delete-plus-add.**

## 🔴 THE PC-WIDE SHEET SWEEP DOES NOT SOLVE THE MAPPING — measured 2026-07-28

Swept all 4 drives: **4,759 spreadsheets → 4,064 profiled (12,126 sheets) → 1,804 sheets in
1,325 workbooks carry both a customer identity AND geography → 491 unique copied to
`D:\PHOENIX MAPPING SOURCE`** (+`_MANIFEST.xlsx`). Scripts: `sweep_inventory.py`,
`sweep_profile.py`, `sweep_score.py`, `sweep_copy.py`, `mine_sheets.py`.

**Mining those 491 against the customers off the master produced 2,304,678 hits — and the
BRICK claims in them are NOT usable:**

| filter applied | left | verdict |
|---|---|---|
| raw brick claims naming a master brick | 1,712 customers | |
| keep only CODE matches (name matching is noise) | 1,158 | 52,917 of 65,194 hits were name-matched; name conflict rate **51%** vs 12% for code |
| keep only where all sheets agree | 1,022 | |
| drop codes shared by 2+ distributors | 778 | |
| **of those, same-area brick refinements** | **31 (4%)** | the only ones worth anything |
| **cross-region** | **552 (71%)** | **demonstrably WRONG** |

Proof they are wrong — the customers' own addresses contradict the sheets:
`اللواءالطبي` addr «ش المعتمدية أرض اللواء بولاق» (Giza) claimed →بحرى (Alexandria) ·
`فارماسيست طنطا` (name says Tanta) →عزبة النخل (Cairo) ·
`غاده احمد` addr «قوص-المفرجية-شنهور» (Qena) →الخصوص (Cairo) ·
`الشفاء الجديدة الطيبة نبروه` (Dakahlia) →أبو حمص (Beheira).

**These old workbooks re-assert stale/incorrect mappings. Do not import brick assignments from
them.** Always test a mined claim against the customer's OWN address before believing it, and
always check the region-distance distribution — a set where 71% cross region is broken, not
insightful.

✅ **What the sweep DID yield: 1,008 customers whose `customer_map.address` is BLANK now have a
real address** (+41 truncated ones extended), e.g. «22 ع حدائق الأهرم بوابة حورس أمام هايبر
العشرين», «191 ش صلاح سالم - ساقية مكى». That is resolver input, and it is the only genuine
gain. Address text beats third-party brick claims every time.

## 🔑 HOW TO REMAP SoS PROPERLY — rebuild from source, do NOT patch the rollups

**`fact_rollup` and `directory_rollup` are DERIVED. `source_of_sales_import_rows` is the source.**
`phx_refresh_sos_fact_rollup(batch_id)` and `phx_refresh_sos_customer_directory_rollup(batch_id)`
delete + re-insert one batch, and they **copy `brick_id` / `area_code` / `region_code` straight
from `import_rows` — they do NOT re-resolve from `customer_map`.** So the order is:

1. write `customer_map`
2. **remap `import_rows`** from `customer_map` (this is the step that actually matters)
3. re-run BOTH RPCs for every validated batch

🔴 **NEVER loop all 89 batches in one statement.** Doing that on 2026-07-28 killed the
connection and took PRODUCTION DOWN — `FATAL 57P03: the database system is not accepting
connections, Hot standby mode is disabled`, app showing APPLICATION ERROR. It recovered by
itself in ~2 min with **zero data damage** (the RPCs are per-batch delete+insert, so a batch is
either whole or untouched). **Chunk to ≤20 batches per call.**

Applied 2026-07-28: `customer_map` 25,064 same-area brick changes (`master-remap-2026-07-28b`),
then `import_rows` 134,523 same-area brick changes, then all 89 batches rebuilt.
Result: `stale_bricks_same_area = 0`; fact 158,258 / 1,441,262.47 and directory 149,488 /
1,229,492.47 **identical before and after**; import qty 1,442,905.17 unchanged.
Verified live at `/admin/field-sales/source-of-sales?period=2026-05` — 19/19 uploaded,
EGP 11.88M, 139,382 units, 47/48 areas.

✅ **The 1,956 area-change rows were also moved (owner approved).** The movement paired almost
perfectly between adjacent areas of the same governorate — **UE5→UE6 +2,165/−2,156 (Sohag) ·
AB4→AB5 +1,659/−1,220 (Beheira) · UE1→UE2 +793/−792 (Minia) · UE3→UE4 +735/−733 (Assiut)** —
which is the signature of genuine boundary corrections, not scatter. Always preview the
per-area net delta before an area move; near-perfect pairing is the evidence you want.

**END STATE: `fact_rollup` agrees with `customer_map` 100% on BOTH brick and area** (was 36%
brick before the remap). All totals identical throughout: fact 158,258 / 1,441,262.47 ·
directory 149,488 / 1,229,492.47 · import 218,825 / 1,442,905.17.

⚠️ **`B182-77 دمنهور` and `B207-32 دمياط الجديد` existed only in `Master of Master (FIXED).xlsx`,
never in `source_of_sales_bricks`.** Writing customer_map pointed 590 customers at
non-existent bricks until I inserted them. **Before any remap, check every target brick exists
in the live masters.**

## ✅ FIXED 2026-07-28 — the OT3 strand (steps 1–2 of 3 applied to PRODUCTION)

**Step 1 — `customer_map`, 1,780 rows, OT3 → 0.** 1,274 re-pointed from the resolver
(`apply_ot3_step1.mjs`), then **506 more fixed with no resolver at all**: those rows already
carried a correct ACTIVE `brick_id` and only their `area_code` still said OT3 — the answer was
on the row. Final: OT6 684 · OT7 675 · OT5 253 · OT4 130 · OT8 38.

**Step 2 — `fact_rollup`, 5,527 of 5,853 rows moved.** Joined `(distributor_code,
client_code-with-leading-zeros-stripped)` → `customer_map`. **5,527 matched, 0 coded-but-
unmatched, and `count(distinct id)` equalled the join count so there was NO fan-out** (that
check is what rules out double-counting). Units: OT6 11,412.33 · OT7 7,738.50 · OT5 1,189.34 ·
OT4 968.00 · OT8 222.00.

**National `sum(effective_units)` = 1,441,262.47 before AND after. 158,258 rows before and
after.** That identity is the only real proof nothing was lost — row counts can look right
while units move.

**326 rows / 4,250.39 units legitimately stay on OT3**: they have NO `client_code`, so they
cannot be attributed to a customer. Verified `ot3_rows_with_a_code = 0`. Report this residual;
never let it be silently dropped.

Two named exceptions, both deliberate:
- Step 1 HELD BACK 2 cross-region rows — `ش شيحة` matched أبو النمرس (Giza) off a street
  fragment, and a `راس غارب` customer was sent to Suez by an old MAPPING.xlsx label when Ras
  Ghareb is Red Sea. Guard: a split repair may only land inside the OT4–OT10 family.
- Step 2 INCLUDED 2 rows (4 units) that moved OT3 → AB1: EG customer `35777` has exactly one
  map row, in AB1, and its fact rows had simply been imported onto OT3. No judgement involved,
  unlike step 1's pair. This is why the OT total falls 4 units short of the 25,784.56 baseline.

Snapshots (the only rollback — these tables have no history):
`fact_rollup_OT3_SNAPSHOT_2026-07-28.json` (5,853) ·
`directory_rollup_OT3_SNAPSHOT_2026-07-28.json` (5,527) ·
`customer_map_OT3_SNAPSHOT_2026-07-28.json` (1,780) · `ot3_baseline_2026-07-28.json`.
⚠️ `customer_directory_rollup` has **no `id` column** — paginate it by
`(period, distributor_code, client_code, product_code)` or rows silently repeat/skip.

**Step 3 — `customer_directory_rollup`, all 5,527 rows moved.** Every row had a `client_code`,
join was 1:1, 0 unmatched. National `sum(effective_units)` **1,229,492.47 before and after**,
149,488 rows before and after, OT3 now 0. Per-area units now match `fact_rollup` **exactly**
(OT6 11,412.33 · OT7 7,738.50 · OT5 1,189.34 · OT4 968.00 · OT8 222.00).

⚠️ A whole-table `area_code <> brick.area_code` check on directory_rollup returns **898 rows —
all PRE-EXISTING in two other areas, none from this repair.** Scope such checks to the rows you
wrote or you will blame yourself for someone else's drift.

**Step 4 — `import_rows`, 7,507 of 7,833 rows moved (owner's call).** I advised leaving it: it
is the raw record of what each uploaded file said, and nothing attributes sales from it (ROI
reads only `invoice_period`; the sole `area_code` consumers are `master-workbook.ts` export and
`reference-gaps.ts` diagnostics). Owner chose consistency over the audit trail. Snapshot taken
first: `import_rows_OT3_SNAPSHOT_2026-07-28.json` (7,833 rows, qty 25,784.56).
Also updated the DENORMALISED `area_name`/`region_name`/`block_code` — this table carries them
as columns, so a code-only update leaves rows self-contradictory. The 326 orphans additionally
still said `area_name='Aswan'` from before the rename; now `'Aswan (Legacy)'`.

### Final state — all four tables agree, every total unchanged

| area | customers | fact | directory | import qty |
|---|---|---|---|---|
| OT6 Luxor | 684 | 11,412.33 | 11,412.33 | 11,412.33 |
| OT7 Aswan | 675 | 7,738.50 | 7,738.50 | 7,738.50 |
| OT5 Hurgada | 253 | 1,189.34 | 1,189.34 | 1,189.34 |
| OT4 New Valley | 130 | 968.00 | 968.00 | 968.00 |
| OT8 Red Sea | 38 | 222.00 | 222.00 | 222.00 |
| OT3 (retired) | **0** | 4,250.39 | – | 4,250.39 |

**Browser-verified in PRODUCTION 2026-07-28** at `/admin/analytics/source-sales/by-area`:
Luxor 3,453 · Aswan 4,767 · Hurgada 987 · New Valley 591 · Red Sea 185 · Aswan (Legacy) 4,250 —
every figure reproduced exactly from SQL. No console errors.

🔑 **The analytics screens do NOT show `effective_units`.** `analytics.sos_fact` (a plain VIEW,
never stale) defines `units = sum(total_qty)` and **excludes product codes `LA003`, `LA004`,
`SS001`** (the confidential products), and `analytics_sos_by_area` additionally drops the
Head Office line by default. So a screen figure will legitimately be far below the raw table —
Luxor shows 3,453 against 11,412.33 `effective_units`, because **70% of Luxor's volume is
confidential product**. Reproduce a screen with:
`sum(total_qty) filter (where product_code not in ('LA003','LA004','SS001'))`
joined to `import_batches ... status='validated'`. Do not "fix" this gap — it is by design.

`fact 1,441,262.47 / 158,258` · `directory 1,229,492.47 / 149,488` ·
`import 1,442,905.17 / 218,825` · `customer_map 49,712` — **identical before and after all four
steps.** directory has no OT3 residual because every one of its rows had a `client_code`.

## ~~🔴 OPEN~~ — 1,780 customers stranded on the RETIRED area `OT3 Aswan (Legacy)` (history)

The 2026-07-27 OT3→OT4–OT10 split was applied to the **masters only**. `customer_map` was never
re-pointed, so **1,780 customers / 21,530 units still carry `area_code='OT3'`**, and Luxor,
Aswan, Hurgada, Red Sea and New Valley all read **zero customers** in any area-scoped report.

The resolver places 1,276 of them (18,227 units): **OT6 Luxor 512 · OT7 Aswan 493 ·
OT5 Hurgada 190 · OT4 New Valley 44 · OT8 Red Sea 35**. Remaining 504 = 253 area-only,
194 block-only, 57 no place at all.

They are invisible in the "resolved" headline because moving a customer to a DIFFERENT area is
class `BRICK - in a DIFFERENT area`, which is held out of auto-apply — so they look missing
while actually being correct. **When reporting coverage per area, count the area-change classes
too, or a retired area looks like it has no sales.**

Knock-on: 7 of the 8 areas with no learned normalizer alias are exactly these OT areas — no
customer is currently *scoped* there for label-learning to draw on. Re-pointing OT3 fixes that
by itself. The 8th, `UE8 Qena 2` (207 customers / 3,114 units), is real and correctly placed —
it simply has no clean distributor label.

### 🔑 THE BIG MATCHING BUG — longest-match is backwards

**Egyptian addresses run specific → broad** (`6ش الحضره البحريه باب شرق` = Hadra St, then the
wider Bab Sharq district). Taking the LONGEST matching phrase systematically picks the wider
district. **The FIRST place named in the address is the customer's actual location.**

Proven on the owner's corrections — both candidates were in the same area, mine lost:

| address | longest (mine, wrong) | first-mentioned (correct) |
|---|---|---|
| `6ش الحضره البحريه باب شرق` | B108-70 باب شرق (7 ch) | **B108-4 الحضره** (6 ch) |
| `القلج البلد الخانكه` | B13-16 الخانكه (7 ch) | **B13-18 القلج** (5 ch) |

Error breakdown of the 8: **2** longest-vs-first · **2** customer NAME should have beaten the
address (`طما`, `بشتيل`) · **1** geocode wrong where the address named no place · **3 master
gaps** — the owner's answer needs a brick that does not exist (`دمياط الجديد`,
`الهضبة الوسطى`, a plain `دمنهور` distinct from `دمنهور شبراخيت`). Roughly 12% is fixable by
rules, 7% is blocked until the master is extended.

**The top 25 customers by units were 25/25 correct** — errors concentrate in small customers
whose addresses name two places.

## ~~DONE~~ 2026-07-28 — `customer_map` remapped in PRODUCTION (READY only) — SUPERSEDED, SEE ABOVE

**22,160 rows updated**, `source='master-remap-2026-07-28'`, `mapped_by='master-of-master'`.
Customers on a master brick: **18,793 (37.8%) → 38,350 (77.1%)**. Verified against the
snapshot: 22,160 changed, all 22,160 planned, **0 unplanned**, **0 area/brick mismatches** in
the written rows (the 3,269 that remain are all pre-existing, in untouched `admin-import` /
`normalizer` / `sheet-verified` rows).

Scope deliberately limited to class `BRICK - resolved` — **no area changes, no ties, nothing
needing a human**. Still unapplied: ~5,300 area changes, ~8,100 ties, ~5,300 rep-needed.

Snapshot (only rollback path, table has no history):
`…\scratchpad\customer_map_SNAPSHOT_2026-07-28.json` (49,712 rows, 18.6 MB).

**`id` is `GENERATED ALWAYS`** — PostgREST upsert fails with 428C9. Update by filter instead:
group rows by identical target and `PATCH ?id=in.(…)` in chunks of ~300 (513 groups → 531
requests for 22k rows).

## ✅ DONE 2026-07-28 — `territory_aliases` rebuilt in PRODUCTION

Old 445 all deactivated (kept, not deleted); **798 guarded aliases inserted, covering 526 of
627 bricks**. Verified: 0 active aliases point outside the master, 0 poisoned tokens present.
Snapshot of the original 445 at
`…\369dd08d-…\scratchpad\alias_SNAPSHOT_2026-07-28.json` — the table has no history, so that
file is the only rollback path.

Of the old 445: 323 pointed outside the master, 85 failed the generic/ambiguity guards, and
**37 survived — all 37 agreeing exactly with the corrected set, zero conflicts.**

Constraints that shape any future write: `UNIQUE (normalized_alias, target_type, target_code)`
(so upsert with `on_conflict=…&Prefer: resolution=merge-duplicates`), `target_type` must be one
of region/area/block/brick, and alias/target_code must be non-blank.

**The table is a GLOBAL map with no area column**, while the resolver is area-aware — so only
phrases naming exactly ONE brick nationally can be written. That is why 798 aliases cover 526
bricks and not all 627: 63 phrases name more than one brick, 73 are generic, 68 are under 4
characters, 17 are governorates.

## The normalizer cannot be used as a source — only as a destination

`source_of_sales_territory_aliases` (445 rows, all `target_type='brick'`) is a curated
alias→brick gazetteer, but **only 122 target a master brick**. Worse, its aliases are matched by
substring and reintroduce the exact bug fixed on 2026-07-28: alias `الصف` fires inside `الصفا`
(`108 الصفا مول`), alias `اسنا` inside unrelated Arabic. Feeding them in would place 833
customers, largely wrongly. **Do not import these aliases.** The correct direction is the
opposite: write the *corrected* gazetteer (with the generic-token guard) INTO this table so
future distributor imports normalise correctly on their own.

## Brick centroids cannot resolve at brick level

Only **260 of 627** master bricks have a centroid; **367 have none**, so nearest-brick can never
select them. Measured on the 359 customers joinable to a geocode, nearest-centroid agrees with
the text match **11%** of the time — and bricks in the same block sit **0 km apart**
(`B10-13 سليم الأول` vs `B10-12 حدائق الزيتون`). Geographic proximity does not discriminate at
brick granularity. See [[locationiq-geocode-provider]].

## Update order that actually works

1. Customers first (`customer_map`) — everything else derives from it.
2. Then decide the `fact_rollup` backfill (its `brick_id` is **frozen at import**, agreeing with
   the customer map only 81% of the time — see
   [[customer-area-code-is-inherited-and-unreliable]]).
3. Then rewrite `territory_aliases` from the corrected gazetteer so imports self-normalise.
4. Centroids for the 367 missing bricks are a separate, optional project.
