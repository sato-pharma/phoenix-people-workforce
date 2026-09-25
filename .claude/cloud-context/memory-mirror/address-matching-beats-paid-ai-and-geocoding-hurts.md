---
name: address-matching-beats-paid-ai-and-geocoding-hurts
description: "Mapping pharmacy codes to bricks - free address matching beat GPT-4o, geocoding made accuracy WORSE, and the BRICK TABLE outranks any geographic model you hold. Never buy a map API for this. For DISTRIBUTOR customers (2026-09-18) a brick place in the pharmacy NAME answers as well as the AI; a place in the ADDRESS only vetoes."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b906c2d-58d1-47e3-a01e-8cfbd14f958f
  modified: 2026-09-18T08:55:49.428Z
---

Backfilling unmapped closing-sheet pharmacy codes into `source_of_sales_customer_map`
(2026-08-27, 13,494 rows written across three passes, source `closing-sheet-backfill-2026-08-27`). Measured on
held-out codes whose true area is already known, area accuracy:

| method | accuracy | cost |
| --- | --- | --- |
| text similarity, name+address | 64.8% | $0 |
| geocode -> nearest brick centroid | 69.0% | ~$72 |
| GPT-4o, name+address+candidates | 81.4% | ~$47 |
| **free matcher + learned territory** | **85.1-88.3%** | **$0** |

**GEOCODING MAKES IT WORSE — 78.9% with Google vs 81.4% without, same pipeline.** Bricks are
SALES territories, not map polygons: the true brick is the nearest centroid only 39.7% of
the time and the true area is in the nearest 3 bricks only 71.4%, so a coordinate drags the
answer toward the wrong place. LocationIQ resolves only **16%** of these addresses at all
(OSM has no record of unpunctuated Arabic sheet addresses like `رقم 20 ش ابوسمبلبجوار مصانع الشريف`),
so it is not a cheaper substitute either. **Do not buy a map API for brick mapping.**

What actually won, in order of contribution:
1. **Learned territory constraint.** Each closing-sheet Area LABEL was matched against what
   it historically resolved to (`Behira 1` -> 2 of today's areas, `Qena` -> 4), intersected
   with the DM's learned territory. Narrows ~50 areas to 1-3 BEFORE the address is read.
   This single change was +5.5 points. A DM territory alone holds the true area 97.5% of the
   time but averages 7.1 areas wide - a filter, never an answer.
2. **Text match against already-mapped pharmacies**, decided at AREA level not brick level,
   IDF *containment* so a short sheet address still matches a longer stored one.
3. **Character 4-grams** on the space-stripped address, because Egyptian sheet addresses run
   words together. Worth only +0.1 overall but it is what catches misspellings.
4. **Bootstrapping.** Re-running after writing pass 1 lifted holdout accuracy 85.1 -> 88.3%
   and rescued 634 more codes for free. The backfill improves the index, it does not poison it.

Beware measuring this wrong: an evaluation that leaves the held-out code's OWN row in the
index reports ~87% for GPT-4o when the honest number is 81.4%. Strip held-out codes from the
index, and rebuild the learned territory maps from the stripped set too.

See [[sos-monthly-closing-is-the-only-sales-truth]] and [[owner-office-allocation-rule-value-share]].

## The brick table outranks your own geography - it corrected 59 of my answers

Pass 3 (2026-08-27) hand-read 1,490 codes I could not place automatically, answering with an AREA
and letting the matcher pick the brick inside it. A self-audit then checked every answer against a
**gazetteer built from the brick names themselves**, and the table overruled me **45 times**, plus
14 of 380 auto-accepted rows. My mental maps of Sharkia and Qena were REVERSED, and Dakahlia and
Sohag each had several towns in the wrong sub-area. **Never trust a remembered map of Egypt over
`source_of_sales_bricks` - build the gazetteer and let it correct you.**

Three rules that gazetteer needs, each learned from a false positive:
1. **Look up the ADDRESS ONLY, never the pharmacy name.** Egyptian pharmacies are routinely branded
   with place names they are nowhere near.
2. **A brick name preceded by a street word is a STREET, not a place** - `شارع النزهة` in Dokki is not
   Alex Center, `قناة السويس` is not Suez. Check the 1-2 preceding tokens against a street-word set
   (ش/شارع/طريق/ميدان/كوبري/ترعة/مسجد/مستشفى...).
3. **Drop tokens under 5 chars and any naming bricks in more than one area.** 549 of thousands survive.

## Rule 1 is REVERSED for distributor customers - measured 2026-09-18

Rule 1 came from the closing-sheet self-audit above. It does NOT carry over to the monthly
normalizer's distributor customers. Re-measured on 2,000 held-out Pharma Overseas pharmacies whose
brick the owner's own sources settled (each one's own mapping removed first):
- a brick place in the **NAME** (one area, one brick, not after a street word, address not pointing
  at another area) was right **exactly as often as GPT-4o** on the pharmacies it answered;
- a brick place in the **ADDRESS** was right **74 times where the AI was right 86** - addresses name
  streets, mosques and neighbouring towns as landmarks.
So PR #4002 ships the owner's own step: the NAME answers, the ADDRESS only VETOES. I had told him
"names mislead" from rule 1 before measuring - the measurement said otherwise. Do not "fix" the name
step back to the address without re-measuring on held-out codes.

Same day, same data: the address match against already-mapped pharmacies (IDF, 10 neighbours
voting by AREA, thresholds 0.7/0.7) answered 764 of 2,000 at **97.5%** area accuracy - more accurate
than the AI. The AI itself cost **$0.54 per 1,000 pharmacies at 60 a call against $1.29 at 20**
(each call re-sends the ~15,000-token brick list), no less accurate.

## SOFICO's sheet codes are a sheet-local numbering that maps to nothing

The closing sheets carry ~851 SOFICO codes shaped `GIZ223584`. SOFICO's real distributor feed is
**100% numeric** - verified live 2026-08-27: 1,574 rows, 829 distinct `client_code`, **zero**
alphanumeric, zero GIZ - and 827 of those 829 codes were already mapped. **Writing the GIZ rows
would have added 851 mappings that match nothing**, making the map look complete while mapping
nobody. Only 3 SOFICO codes were genuinely missing, all numeric. Before writing a distributor's
codes, confirm the code SPACE exists in `source_of_sales_import_rows.client_code` (note: the column
is `client_code`, NOT `customer_code`). A sheet code is not automatically a real code.

Beware one case trap here: "there are zero alphanumeric SOFICO codes in the map" was WRONG when I
first said it - `giz208554` exists in lowercase. Match with `~*`, never `~`.
