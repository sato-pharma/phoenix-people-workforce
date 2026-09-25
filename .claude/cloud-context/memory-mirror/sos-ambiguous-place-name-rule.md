---
name: sos-ambiguous-place-name-rule
description: "THE RULE: a place name resolving to two different bricks must resolve to NOTHING, never to a guess. Egypt reuses names across governorates; 12 such pairs are live and correct."
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-28T20:44:57.780Z
---

Owner, 2026-07-28: *"we must set a rule for the similar bricks name to avoid sales mixing"* — and on
the 12 live same-name pairs: **`dol bricks mokhtlfa msh ghaltha sebhum zy mahoma`** (they're
different bricks, not a mistake, leave them).

## The rule

**A place name that resolves to two different targets resolves to NOTHING — the row goes to review,
never to a guess.** Shipped as `buildAliasIndex` in `src/lib/sales/normalizer/crosswalks.ts`
(PR #1440), applied to the territory / area / region alias maps.

## Why it matters

Egypt reuses place names across governorates. Live, deliberate, and correct:
`الصالحية` (Sharkia 2 + Qena 2) · `الرحمانية` (Behira 1 + Kafr El-Sheikh 2) ·
`ابراهيميه` (Alex Center + Sharkia 1) · `مصطفى كامل` (Alex street + Downtown square) ·
`منشاه` · `رشدي` · `نزهه` · `صلاح دين` · `خطاطبه` · `اسماعيليه` · `رمسيس` · `عرب الاطاولة`.

**The bricks were never the bug — the alias index over them was.**
`source_of_sales_territory_aliases` is uniquely indexed on
`(normalized_alias, target_type, target_code)`, so ONE name may legally point at TWO bricks. The old
code did a plain `.set()` → whichever row PostgREST returned last silently won, order-dependently.
Sales would land in the wrong area, credited to the wrong rep, with no trace. Prod had **0**
ambiguous aliases at the time of the fix, so nothing was mis-attributed — nothing prevented the next
import from creating one.

## Merge decision rule (owner's, confirmed twice)

| Same name + … | Action |
| --- | --- |
| same **area** | merge — "no judgement needed" |
| same region, different **area** | his call |
| different **region/governorate** | **normal, leave both** |

Applied 2026-07-28: 8 merges (bricks 704→696), then the remaining 12 pairs left alone by his ruling.
`B181-2` renamed `عرب الاطاولة - مركز الفتح` (its customers' addresses say مركز الفتح) to
disambiguate it from the Sohag `عرب الاطاوله` near Sohag University — evidence-based, not merged.

## Two traps

- **Never fuzzy-match short Arabic names across governorates.** Stripping `اويهءئؤةى` collapses
  `بوش` (Beni Suef) and `إبشواى` (Fayoum) both to `بش` — my matcher proposed merging them, which
  would have moved 28 customers into the wrong governorate. Rank candidates by GEOGRAPHY FIRST
  (same area > same region > different), then by match strength.
- **`tsconfig.tsbuildinfo` caches type errors.** `incremental: true` is on; after editing a `type`,
  a stale buildinfo kept reporting a fixed error. `rm -f tsconfig.tsbuildinfo` before believing a
  typecheck failure that contradicts the source.

See [[sos-owner-standing-rules-from-session-369dd08d]] and [[sos-master-complete-704-applied-2026-07-28]].
