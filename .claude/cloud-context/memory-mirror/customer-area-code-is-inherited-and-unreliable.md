---
name: customer-area-code-is-inherited-and-unreliable
description: "source_of_sales_customer_map.area_code is inherited from the old coarse brick — 12,765 customers' addresses point to a place the new master puts in a DIFFERENT area"
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-28T00:23:38.718Z
---

Measured 2026-07-28 over all 49,712 `source_of_sales_customer_map` rows.

**Do not restrict customer→brick matching to the customer's current `area_code`.** That
field came from the old coarse brick, and the 2026-07-27 master redrew area boundaries.
Restricting to it caps address matching at **48.7%**; allowing a cross-area fallback
lifts it to **74.4%**.

Concrete proof — the place is in the master, just not in the area the customer sits in:

| Address says | Brick lives in | Customer's `area_code` |
|---|---|---|
| `عين شمس` | CA3 | CA4 |
| `المهندسين` | GZ2 | GZ3 |
| `سبرباي` | D14 | D15 |
| `الشرابيه` | CA6 | CA5 |

Accepting a cross-area match moves the customer to a different rep **and** a different
district manager, so those 12,765 rows must go to human review, never auto-apply.

## Resolution ceiling (all 49,712) — final, multi-signal

Two owner corrections drove this, both worth keeping:

1. **"all must be mapped from the new"** — old brick names were in the gazetteer. Removing
   them *raised* the hit rate 74.4% → 77.1%, because an old-name hit was short-circuiting
   the search for a new brick. Never put old bricks in the gazetteer.
2. **"don't depend only on address — look at the name too"** — pharmacy names carry the
   place (`نور الايمان امبابة`). Adding the customer name to the haystack took it to **85.0%**.
   **10,094 rows matched on the NAME alone** and would have been missed on address only.

| Verdict | Rows | Units |
|---|---|---|
| READY — one brick, customer's own area | 25,992 (52.3%) | |
| REVIEW — AREA CHANGES | 14,069 (28.3%) | |
| PICK ONE — several candidates | 2,209 (4.4%) | |
| **on a new brick, total** | **42,256 (85.0%)** | **88.6% of units** |
| REP NEEDED — no place in address or name | 2,831 (5.7%) | 6.8% |
| NO DATA — row is blank | 4,611 (9.3%) | 4.1% |

**4,611 `customer_map` rows have NULL `customer_name` AND NULL `address`** — blank shells
carrying only distributor + customer code. 2,708 of them have real sales. Mostly `IS-S`,
`EG`, `IS`, `RM`. No algorithm can place these.

## 🔴 THE BIGGEST BUG — street-named bricks tokenised into first names

Some bricks are named after **streets**, not districts: `ش أحمد تيسير`, `ش صلاح الدين`,
`ش جمال عبد الناصر`, `ش مصطفى كامل`, `النزهه الجديدة`. Splitting those names into single
tokens made **`احمد` a place matcher** — and it appears in **14.21% of all customers**.
Result: **8,588 of 13,546 proposed area changes were WRONG** (69% crossed a sales region;
customers were being dragged from Dakahlia to Giza on a first name).

Worst offenders and what they matched on: `B220-3 النزهه الجديدة`→`الجديده` (1,053 false),
`B220-1 ش أحمد تيسير`→`احمد` (716), `B105-M1 ش جمال عبد الناصر`→`عبد` (345),
`B149-12 ش مصطفى كامل`→`مصطفي` (294), `B196-10 ش صلاح الدين`→`الدين` (275).

**The fix — regional concentration, not raw frequency.** Raw document frequency would also
block `المنيا` (1.72% of customers) which is a real city. Instead, for each token measure the
share of its customers falling in the single most-common sales region:

| token | customers | top-region share | |
|---|---|---|---|
| `المنيا` | 854 | 97.4% | real place — keep |
| `سوهاج` | 543 | 97.4% | keep |
| `احمد` | 7,064 | 21.5% | **generic — block** |
| `الجديده` | 4,164 | 22.0% | **block** |
| `كفر` | 2,214 | 50.1% | block alone (`كفر سعد` still matches) |

Threshold **< 60% concentration with ≥25 customers ⇒ generic** (187 tokens).

**Apply the block narrowly.** Refusing generic tokens outright cost 23 points of coverage
(98.8% → 75.8%), because Arabic addresses glue words so full multi-word phrases often miss.
Generic tokens are fine **inside the customer's own area** (the area isn't in question there)
— they must only be refused when the match would **move the customer to another area**.

**Also: cross-area matches must stay inside the region.** Every legitimate move does
(OT3 split, UE6→UE5, CA4→CA3, D22→D21, AB3→AB1). Cross-region moves fell 9,360 → 198.

After both fixes: area changes 13,546 → **5,150**, REJECT rate **62.1% → 2.7%** of units,
SAFE **14.5% → 70.2%**.

## Auditing an area change — four independent tests

1. **Consensus** — do the customer's OLD-BRICK siblings make the same move? A boundary redraw
   moves a whole brick; a false match moves one customer.
2. **Region** — does it stay inside the sales region?
3. **Specificity** — length of the matched phrase; exact full brick name is strongest.
4. **Uniqueness** — is this the only brick in the master carrying that name?

## FINAL RESULT 2026-07-28 — 98.76% of customers mapped to the new 627 master

49,097 of 49,712 land on a new brick, carrying **99.33% of units**. Only **3 customers in
the entire database** cannot be identified at all. 615 rows need a human.
READY 31,886 · REVIEW-area-changes 13,503 · PICK ONE 3,708 · REP NEEDED 612 · NO DATA 3.

**Line closing / IMS workbooks are a customer directory.** This was the surprise: files like
`CNS Semester 1.xlsx`, `2024-2025-2026 Ped Line.xlsx`, `2024-2025-2026 Anti Line.xlsx`,
`Q1-Jun-2026 Sales Closing (CNS Line) Final.xlsx` carry customer codes WITH names and
addresses that never reached `source_of_sales_customer_map`. Sweeping 120 files across the
user profile identified **3,043 of 3,046** remaining dark codes. Always mine the line-closing
workbooks before declaring a customer unidentifiable.

**Merging recovered text: concatenate, never choose.** A code can appear in several files with
partial text in each; picking one record loses signal. Joining all name/address/geo strings
turned 96 more rows resolvable.

**Sweep trap:** `find` run from a `cd`-ed directory emits RELATIVE paths; a scanner running
elsewhere then silently fails every open. Two full runs reported a clean "0 of 3,046" without
opening a single file. **A perfect zero across many diverse files means a bug, not a finding —
assert the paths resolve (`os.path.isfile`) before trusting any sweep result.**

## 🔑 The single most valuable file — `Desktop\June - 2026\2026-06-12\MAPPING.xlsx`

**19.5 MB, 12 sheets, one per distributor** (`MC`, `Unique`, `Sheet11`, `EGD`, `EG-1002`,
`EPDA`, `IS-S`, `IS`, `OVERSEAS`, `POS2`, `RAMCO`, `SOFICO`). Each is a customer directory:
code + name + address, several with Territory/Brick/Governorate too. Arabic headers on some
(`كود` / `العميل` / `العنوان` / `المنطقة`), English on others (`Client Code` / `Address_En`).

**This is what cracks the blank `customer_map` rows.** 4,611 rows in `source_of_sales_customer_map`
have NULL name AND NULL address — but **55% of them exist in MAPPING.xlsx with a real address**.
Folding it in took the resolver from **87.0% → 93.4%** and cut rows needing a human from
12,710 → **3,266**. Match on `customer_code` with leading zeros stripped, and strip a trailing
`.0` (some codes arrive as floats).

Always check MAPPING.xlsx before declaring a customer unidentifiable.

## Two local files are essential inputs — `C:\Users\satoh\OneDrive\Desktop\Areas Database`

Owner pointed these out 2026-07-28; they took the result from 85.0% → **87.0%**.

- **`bricks_separated_with_boundaries.xlsx`** (11 MB) — per-region sheets (CAI/GIZ/UE/ALEX/D 1/
  D 2/Others) plus `*_Combined`. Yields **1,081 `location → block code` pairs / 1,003 distinct
  sub-location names** — the names people actually write in addresses, far richer than the 627
  brick names. Only 59 of its 148 blocks are in the new master. `ALEX_Combined` carries a full
  Location/Code/Area/District/Region hierarchy.
- **`Areas x Disrb database.xlsx`** (2.6 MB) — the `POS` sheet holds **12,553 already-Google-geocoded
  addresses**: `Helper Address`, Arabic `District`, `Governorate`, confidence, `Location type`
  (3,434 ROOFTOP / 7,008 APPROXIMATE). 14,487 of our customer addresses match it exactly.
  Its Arabic `District` alone produced **4,276 brick matches**.
  ⚠️ **Its `Area` and `Region` columns are MISALIGNED — do not use.** Ismailia → "Safaga /
  Upper Egypt", New Valley → "Kafr Al Sheikh First / Delta (1)", Maadi → "El Sayeda Zeinab".
  Only `District` and `Governorate` are trustworthy.
- `Raw\sato N-2026\` — original monthly distributor workbooks (ibnsina, egd, ramco, sofico,
  chimipharm, mec, epda, tenders). **Not yet mined.**

**Classification trap found here:** a sub-location match can resolve into a *different* area.
Those were initially labelled READY — 39 rows that would have silently moved a customer to
another rep and manager. Any tier that can cross an area must re-check `area_code` before
marking a row ready.

## Geocoding was tested and REJECTED — do not retry without a bounding box

LocationIQ on street-only Arabic addresses returns confident, wrong answers, because the
input has no city so it matches that street name *anywhere in Egypt*:

| Address | Customer is in | Geocoder returned |
|---|---|---|
| `ش67 النبي دانيال` | D22 Sharkia | 6 أكتوبر, الجيزة (Nabi Daniel is an *Alexandria* street) |
| `ش موقف صندفا` | UE2 Minia | طنطا, الغربية |
| `ناصية ش يسرى خطاب` | GZ3 Giza | الدلنجات, البحيرة |

7 of 8 successful geocodes "matched a brick"; at least 6 were the wrong governorate.
If ever retried, constrain with `viewbox` + `bounded=1` to the customer's governorate
(governorate level *is* reliable; only area-level is not).

**Also: `LOCATIONIQ_API_KEY` is shared with production CRM check-in geocoding and is
saturated — 0/5 succeeded at one request every 5 seconds, `{"error":"Rate Limited Second"}`.
A batch job needs its own key.**

## What made matching work

Gazetteer of 3,158 phrases per area built from three sources — **new brick names**,
**block-name components** (block names are place *lists*: `أبيس – الظاهرية – العوايد`
is three villages), and old brick names. Arabic normalisation (أإآ→ا, ة→ه, ى→ي, strip
harakat), admin words (`مدينة/مركز/بندر/قسم`) dropped, definite article stripped as a
variant. Substring match for phrases ≥4 chars; 3-char names must stand alone as a token
or they false-match badly. Keep only the **longest** matches before counting candidates —
that alone collapsed false ambiguity from 7,005 rows to 1,762.

## Other facts confirmed the same day

- `source_of_sales_fact_rollup.brick_id` is **frozen at import**, not a live join — it
  agrees with `customer_map.brick_id` only **81%** of the time. Remapping customers does
  NOT move historical sales; that needs a separate backfill decision.
- **1,780 customers still sit on the retired `OT3`** (Aswan Legacy) and must be moved into
  the OT4–OT10 split. See [[sos-others-region-split-2026-07-27]].
- Distributor import files do **not** carry route/territory data — `raw_row` is null for
  every distributor except `DIRECT` (whose extra columns are `D.S.M.`/`Region ID`, both
  org-level). The address is the only geographic signal.
- 430 of 1,140 bricks hold customers; 468 hold sales.
