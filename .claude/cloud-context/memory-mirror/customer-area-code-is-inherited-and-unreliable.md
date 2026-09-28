---
name: customer-area-code-is-inherited-and-unreliable
description: "source_of_sales_customer_map.area_code is INHERITED from the old coarse brick and unreliable — a customer's address can point to a place the new master puts in a DIFFERENT area, so never restrict customer→brick matching to the current area_code, but send every cross-area match to human review (it moves the rep AND the DM). The methods that made matching work, and the traps that made it lie: street-named bricks tokenise into first names (block by regional concentration, not frequency), geocoding on street-only Arabic addresses returns confident wrong answers, and a perfect-zero sweep is a path bug."
metadata:
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-09-26T00:06:44.262Z
---

Measured over all ~49,712 `source_of_sales_customer_map` rows, 2026-07-28. The exact percentages and
verdict counts below are a stale one-off snapshot; the **methods and traps are durable.**

## The core fact

`area_code` on a customer-map row came from the **old coarse brick**, and the master redraws area
boundaries, so a customer's address routinely names a place the new master puts in a **different area**:

| Address says | Brick lives in | Customer's `area_code` |
|---|---|---|
| `عين شمس` | CA3 | CA4 |
| `المهندسين` | GZ2 | GZ3 |
| `الشرابيه` | CA6 | CA5 |

**So do NOT restrict customer→brick matching to the current `area_code`** — it caps address matching
badly; a cross-area fallback lifts it a lot. But a cross-area match moves the customer to a **different
rep AND a different district manager**, so those rows go to **human review, never auto-apply.**

## 🔴 The biggest bug — street-named bricks tokenise into first names

Some bricks are named after **streets**, not districts (`ش أحمد تيسير`, `ش صلاح الدين`,
`ش جمال عبد الناصر`). Splitting those into single tokens made **`احمد` a place matcher** — and it
appears in ~14% of all customers — so customers were dragged across regions on a first name.

**The fix is regional CONCENTRATION, not raw frequency** (raw frequency would also block real cities):
for each token, measure the share of its customers falling in its single most-common sales region.
**< 60% concentration with ≥25 customers ⇒ generic — block it.**

| token | top-region share | verdict |
|---|---|---|
| `المنيا` | 97.4% | real place — keep |
| `احمد` | 21.5% | **generic — block** |
| `كفر` | 50.1% | block alone (`كفر سعد` still matches) |

**Apply the block NARROWLY.** A generic token is fine **inside the customer's own area** (the area
isn't in question there) — refuse it only when the match would **move the customer to another area**;
refusing it outright cost ~23 points of coverage because Arabic addresses glue words. **And every
cross-area match must stay inside the sales REGION** — a legitimate boundary redraw always does; a
cross-region move is almost always a false match.

## Auditing an area change — four independent tests

1. **Consensus** — do the customer's OLD-BRICK siblings make the same move? A boundary redraw moves a
   whole brick; a false match moves one customer.
2. **Region** — does it stay inside the sales region?
3. **Specificity** — length of the matched phrase; the exact full brick name is strongest.
4. **Uniqueness** — is this the only brick in the master carrying that name?

## What made matching work

- **Two owner rules.** *"All must be mapped from the new"* — **never put OLD brick names in the
  gazetteer**; an old-name hit short-circuits the search for a new brick. *"Don't depend only on
  address — look at the name too"* — pharmacy names carry the place (`نور الايمان امبابة`), and adding
  the **customer name** to the haystack matched thousands of rows that address alone would miss.
- **Gazetteer** built from new brick names + **block-name components** (a block name is a place *list*:
  `أبيس – الظاهرية – العوايد` is three villages) + old brick names (as a variant only, never as a
  match target). Arabic normalisation (أإآ→ا, ة→ه, ى→ي, strip harakat), drop admin words
  (`مدينة/مركز/بندر/قسم`), strip the definite article as a variant. Substring match for phrases ≥4
  chars; a 3-char name must stand alone as a token or it false-matches. **Keep only the LONGEST matches
  before counting candidates** — that alone collapsed most false ambiguity.
- **Blank shells cannot be placed by any algorithm.** ~4,611 rows have NULL `customer_name` AND NULL
  `address`, carrying only distributor + customer code (mostly `IS-S`/`EG`/`IS`/`RM`); many have real
  sales.

## Where to find a customer an algorithm can't place — mine files, don't geocode

- **Line-closing / IMS workbooks are a customer directory.** Closing and IMS `.xlsx` files carry
  customer codes with names and addresses that never reached `customer_map`. **Always mine them before
  declaring a customer unidentifiable.**
- 🔑 **`Desktop\June - 2026\2026-06-12\MAPPING.xlsx`** (19.5 MB, 12 sheets, one per distributor:
  code + name + address, some with Territory/Brick/Governorate) is the single most valuable file for
  cracking the blank rows. Match on `customer_code` with **leading zeros stripped and a trailing `.0`
  stripped** (some codes arrive as floats).
- **`C:\Users\satoh\OneDrive\Desktop\Areas Database`** (owner-supplied):
  `bricks_separated_with_boundaries.xlsx` gives `location → block code` pairs, far richer than the bare
  brick names; `Areas x Disrb database.xlsx` `POS` sheet holds ~12,553 Google-geocoded addresses.
  ⚠ **In that POS sheet, the `Area` and `Region` columns are MISALIGNED — use only `District` and
  `Governorate`** (Ismailia → "Safaga / Upper Egypt", Maadi → "El Sayeda Zeinab").
- **Merging recovered text: concatenate, never choose.** A code appears in several files with partial
  text in each — join all name/address/geo strings rather than picking one record.
- **Sweep trap:** `find` run from a `cd`-ed directory emits RELATIVE paths, so a scanner running
  elsewhere silently fails every open. **A perfect zero across many diverse files is a bug, not a
  finding — assert every path resolves (`os.path.isfile`) before trusting a sweep result.**

## Geocoding was tested and REJECTED — do not retry without a bounding box

LocationIQ on street-only Arabic addresses returns **confident, wrong** answers, because the input has
no city so it matches that street name *anywhere in Egypt* (`ش67 النبي دانيال` in Sharkia → 6th of
October; Nabi Daniel is an *Alexandria* street). If ever retried, constrain with `viewbox` + `bounded=1`
to the customer's **governorate** — governorate level *is* reliable, only area level is not
([[address-matching-beats-paid-ai-and-geocoding-hurts]]). Also `LOCATIONIQ_API_KEY` is **shared with
production CRM check-in geocoding and is saturated** — a batch job needs its own key.

## Other durable facts confirmed the same day

- **`source_of_sales_fact_rollup.brick_id` is FROZEN at import, not a live join** — it agrees with
  `customer_map.brick_id` only ~81% of the time. **Remapping customers does NOT move historical sales**;
  that needs a separate backfill decision.
- As of this measurement, distributor import files carried **no** route/territory data (`raw_row` null
  for every distributor except `DIRECT`, whose extras are org-level), so the address was the only
  geographic signal. (Later IS/IS-S imports do carry a `Brick Name` column — verify per distributor.)
- The retired-`OT3` (Aswan Legacy) customers belong in the OT4–OT10 split
  ([[sos-others-region-split-2026-07-27]]).
