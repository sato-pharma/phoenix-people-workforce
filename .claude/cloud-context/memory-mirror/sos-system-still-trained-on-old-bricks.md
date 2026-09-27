---
name: sos-system-still-trained-on-old-bricks
description: "The 2026-07-28 remediation that re-pointed the whole SoS stack (customer_map, import_rows, fact/directory rollups, territory aliases) from the pre-2026-07-27 bricks onto the 627-brick master — DONE, fact_rollup now agrees with customer_map 100% on brick and area. Keep for the owner-validated address-matching rules, the FIRST-place-named-wins rule (longest-match is backwards), the proper remap order + the 'never loop all 89 batches' production-outage trap, and the reusable DB/analytics traps."
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-09-26T02:49:03.717Z
---

Owner flagged 2026-07-28 "sos is trained on old bricks, needs update" — system-wide (normalizer aliases,
brick centroids, customer map, fact/directory rollup all pointed at superseded bricks). **REMEDIATED the
same day:** `customer_map`, `import_rows`, both rollups and `territory_aliases` were re-pointed onto the
627-brick master; end state `fact_rollup` agrees with `customer_map` 100% on BOTH brick and area (was 36%),
every national total identical before/after. This file is kept for the RULES and METHOD, not the tallies.

## Owner-validated matching rules (do NOT relearn or reverse)

- **A customer's own ADDRESS beats a third-party geocoded district** — and when the address points into
  another area, the row is DEMOTED TO REVIEW, never auto-applied.
- **Name-only matching is sound** when the name carries a real place (`مكه فارما - اسيوط` → مدينة أسيوط).
- **A street beats a nearby square** (`5ش الجلاء رمسيس` → ش الجلاء, not ميدان رمسيس); **a generic street name
  must not beat a city** (`ش احمد سلطان … الزقازيق` → الزقازيق, not the Cairo ش الجيش brick).
- **An ambiguous distributor territory label is NOT evidence** — labels naming two places at once
  (`SUEZ /S SINAI`, `Ismailia-Suez`) must never auto-resolve; send the customer to the rep.
- **Distributors may book a customer under a NEIGHBOURING territory** (owner confirmed a Sharm customer at
  جويا مول belongs to Suez for that distributor) — do NOT "correct" a territory on geography alone.
- **A place with a STREET head-word in front is a street NAMED AFTER it, not the place** (`شبين الكوم - ش
  دنشواى` = Danshway St inside Shibin El-Kom) — drop street-prefixed candidates only when a real place also
  matched.

## 🔴 THE BIG MATCHING BUG — longest-match is backwards, first-named wins

**Egyptian addresses run specific → broad** (`6ش الحضره البحريه باب شرق` = Hadra St, then the wider Bab
Sharq district). Taking the LONGEST matching phrase systematically picks the wider district. **The FIRST
place named in the address is the customer's actual location.** The refinements that took the measured error
from 20% to 2.5% (all validated on the owner's judgements):

- **RULE G — the FIRST place named wins, not the longest** — but only among matches on a brick's FULL name;
  among fragments the longest still wins.
- **RULE SMALL — "ALWAYS MAP ON THE SMALLEST BRICK AVAILABLE" (owner's governing principle).** Two guards:
  (1) an area's catch-all CAPITAL loses to any smaller brick, but ONLY when every surviving candidate matched
  its brick's FULL name (on fragment matches it broke `المحله الكبرى`→`محلة حسن`); (2) when one brick name
  word-contains another, the LONGER is the smaller place (`حدائق حلوان` ⊂ `حلوان`) — compare WORD-WISE, never
  as a raw substring (`اجا` sits inside `سفاجا`). Do NOT rank by word count — most Egyptian place names are
  two words.
- **RULE H2 — an area's capital brick loses to a town named in the CUSTOMER NAME**, scoped tightly (fires
  only when the winner is a capital AND the name offers an alternative; the blanket "demote every capital"
  version wrongly moved `المحله الكبرى`).
- **GOVERNORATE GUARD** — a single-word phrase may match glued inside a token (`العامريةصحراوي`; 920 customers
  resolve ONLY via substring, so do not require a word boundary) but not inside a GOVERNORATE name (`منوف`
  fired inside `المنوفيه`). Require one occurrence outside a governorate set.
- **INFLECTION guard** — reject a substring match when what follows is an Arabic inflection ending
  (`ي، يه، وي، اوي، ه، ا، ات، ين، يا`): `صدفا` inside `الصدفاوى`. Do NOT reject on remainder length — `بم`
  (بملك) / `ش` (شارع) are glued on constantly, and a ≥4-char rule threw away 178 good rows.
- **`شارع` must normalise to `ش`** — 37 bricks are named with the abbreviation while addresses spell it out.
- **Brick full-name minimum is ≥4 chars, not 5** — 53 real bricks have 4-char names (`زفتي`, `إدكو`, `رشيد`).
- **OWNER RULINGS layer** — a place the owner settles by name points at an EXISTING brick
  (`الهضبة الوسطى → B31-55 المقطم`), checked before every tier; never invent a brick for these.

🔴 **Do NOT trust internal consistency as an accuracy measure.** A twin-address proxy said 4.4% and a 12-row
in-chat sample said 0% when the real error rate was 20% — only an owner-judged RANDOM sample found it. Ask
for one BEFORE writing, not after. Errors concentrate in small customers whose addresses name two places;
the top-25-by-units were 25/25 correct.

## 🔑 HOW TO REMAP SoS PROPERLY — rebuild from source, do NOT patch the rollups

`fact_rollup` and `directory_rollup` are DERIVED; `source_of_sales_import_rows` is the source.
`phx_refresh_sos_fact_rollup(batch_id)` and `phx_refresh_sos_customer_directory_rollup(batch_id)` delete +
re-insert one batch and **copy `brick_id`/`area_code`/`region_code` STRAIGHT from `import_rows` — they do NOT
re-resolve from `customer_map`.** So the order is:

1. write `customer_map`
2. **remap `import_rows` from `customer_map`** (the step that actually matters)
3. re-run BOTH RPCs for every validated batch — and update `import_rows`' DENORMALISED
   `area_name`/`region_name`/`block_code` columns too, or rows are self-contradictory.

🔴 **NEVER loop all 89 batches in one statement — doing that took PRODUCTION DOWN** (`FATAL 57P03 … not
accepting connections`); it self-recovered in ~2 min with zero data damage (RPCs are per-batch
delete+insert, so a batch is whole or untouched). **Chunk to ≤20 batches per call.**

- 🔴 **Before any remap, check every target brick EXISTS in the live `source_of_sales_bricks`** — two bricks
  the owner added lived only in the fixed XLSX, so writing customer_map pointed 590 customers at
  non-existent bricks until they were inserted.
- **A merge is only safe if the customers' CURRENT area matches the target brick's area** (طلخا/نبروه looked
  like duplicates but sat in a different area — an area move, not a merge). **No block spans two areas
  (verified 0), so a master brick can't be moved between areas alone** — move the whole block or add a new
  brick. Diagnose off-master customers BY BRICK (~14 duplicate bricks, not thousands of problems).
- **The only rollback is a JSON snapshot — these tables have no history.** `customer_map.id` is
  `GENERATED ALWAYS` (PostgREST upsert fails `428C9`; update by filter, `PATCH ?id=in.(…)` in chunks).
  `customer_directory_rollup` has NO `id` column — paginate by `(period, distributor_code, client_code,
  product_code)` or rows silently repeat/skip. Verify no fan-out with `count(distinct id) == join count`,
  and prove nothing was lost by national `sum(effective_units)` identity, not row counts.
- **Scope a `area_code <> brick.area_code` drift check to the rows YOU wrote** — a whole-table check returns
  hundreds of PRE-EXISTING mismatches in other areas and makes you blame yourself for someone else's drift.
- **When reporting coverage per area, count the area-CHANGE classes** (`BRICK - in a DIFFERENT area` is held
  out of auto-apply) — otherwise a correctly-remapped retired area looks like it has no sales. Preview the
  per-area net delta before an area move; near-perfect pairing between adjacent same-governorate areas
  (e.g. `UE5→UE6 +2,165/−2,156`) is the signature of a genuine boundary correction, not scatter.

## 🔑 Analytics screens do NOT show `effective_units` — by design, don't "fix" it

`analytics.sos_fact` (a plain VIEW, never stale) defines `units = sum(total_qty)` and **excludes confidential
product codes `LA003`, `LA004`, `SS001`**; `analytics_sos_by_area` additionally drops the Head Office line by
default. So a screen figure is legitimately far below the raw table (Luxor showed 3,453 vs 11,412
`effective_units` — 70% of its volume is confidential). Reproduce a screen with
`sum(total_qty) filter (where product_code not in ('LA003','LA004','SS001'))` joined to validated batches.

## Territory labels: the alias tables, and why substring matching poisons them

- **A TERRITORY is COARSER than a brick** (`اسيوط` spreads over مدينة أسيوط + الوليديه + الفتح), so a label
  may only ever target an **AREA** — a brick-level label alias drags the whole territory onto its capital,
  the opposite of the smallest-brick rule. The right table is **`source_of_sales_area_aliases`** (it was
  empty though `crosswalks.ts`/`resolvers.ts` already read it). Resolution order makes area rows safe: the
  TERRITORY alias (brick then area) is consulted first, the AREA alias only on a miss — so an area row can
  fill a gap but never make an existing mapping coarser.
- **`source_of_sales_territory_aliases` is a DESTINATION, not a source.** Its aliases are matched by
  SUBSTRING and reintroduce the exact bug (alias `الصف` fires inside `الصفا`); feeding them in places
  customers wrongly. Write the CORRECTED gazetteer (with the generic-token guard) INTO the table so future
  imports self-normalise. It is a GLOBAL map with no area column, so only a phrase naming exactly ONE brick
  nationally can be written; `UNIQUE (normalized_alias, target_type, target_code)`, `target_type` ∈
  region/area/block/brick.
- 🔴 **A resolver bug worth remembering:** it was pasting the distributor's TERRITORY LABEL into the text it
  matches on (`nrec_addr` included `_rc['geo']`) and the first tier read it, so a routing code outranked the
  customer's own address. Fix: keep `geo` OUT of `nrec_addr`, only in `nrec` (the last-resort haystack) —
  removing it altogether is also wrong (a few rows resolve by label alone).

## Reference data and hard ceilings

- **Brick centroids cannot resolve at brick level** — only 260 of 627 bricks have one, nearest-centroid
  agrees with the text match 11%, and bricks in the same block sit 0 km apart. Geographic proximity does not
  discriminate at brick granularity. [[locationiq-geocode-provider]]
- **`fact_rollup.brick_id` is FROZEN at import**, agreeing with the customer map only ~81% of the time — see
  [[customer-area-code-is-inherited-and-unreliable]]; that is why a rollup backfill is a deliberate decision,
  not an automatic consequence of rewriting `customer_map`.
- **`Desktop\Raw` = the six ORIGINAL monthly distributor files** (`sato 1-2026`…`sato 6-2026`, one workbook
  per distributor). What each distributor calls geography: Overseas (PS) `Sal. Dist. Desc.` (clean Arabic
  places); Ibn Sina (IS) English `REGION CITY` pairs + `old brick` 6-digit legacy id; EPDA `TerritoryName`,
  Ramco `منطقة`, Sofico `ZipCodeName`, MEC `bricks`. ⚠️ **`EG` labels are BRANCH names (`فرع دمياط`) = the
  warehouse shipped FROM, never the customer's location — exclude from all learning**; `brick`/`bricks`
  columns hold the OLD 6-digit numbering, not master ids. Raw NAMES/addresses fill codes `customer_map`
  leaves blank (the genuine gain), but **address truncation at 29–30 chars is in the distributors' OWN files**
  (28% of customers) — a hard accuracy ceiling, do not go looking for it again.
- **Mined brick claims from old workbooks across the PC are NOT usable** — filtered to code-only agreeing
  claims, 71% cross REGION (demonstrably wrong; the customers' own addresses contradict them). Always test a
  mined claim against the customer's OWN address, and check the region-distance distribution — 71% crossing
  region means broken, not insightful. The only genuine yield of a sheet sweep was 1,008 blank addresses
  filled: address text beats third-party brick claims every time.

## `FINAL NEW (3).xlsx` — REJECTED as a master, kept only as the conflict arbiter

Handed over as "your source of truth" but it is an OLDER, COARSER generation (597 bricks/42 areas vs the live
629/48). Owner's verdict after the diff: **"forget about it, keep us as we are"** — nothing from it was
applied. Applying it would have reversed the OT split, deleted fine-grained bricks (the Nasr City street
series, Gharbia/Mahalla villages) that make "always the smallest brick" possible, and RENAMED 10 bricks by
spelling (`زفتي→زفته`), breaking address matching. **Arbitration rule:** when a conflict arises it wins, but
TELL THE OWNER FIRST. ⚠️ **Always diff a new master by brick NAME as well as id** — 4 of its 5 "new" bricks
were only RE-NUMBERED, and a re-number reads as a delete-plus-add otherwise.
