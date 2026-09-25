---
name: sos-duplicate-brick-ids-same-place
description: "SoS bricks master holds the same place twice under legacy and current IDs; detecting them needs a fuzzy Arabic key or the count is badly undercounted"
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-28T16:40:48.117Z
---

The `source_of_sales_bricks` master carries **the same place, in the same area, under two
different brick_ids** — one from the legacy `Vlookup-Masterrr.xlsx` import, one from the
current `FINAL NEW.xlsx` master. The current-master side holds all the customers; the legacy
twin holds **zero customers but still accumulates sales** in `fact_rollup`, because
`source_of_sales_import_rows` still carried the legacy brick_id and the refresh RPCs copy
brick_id straight from import_rows.

Resolved 2026-07-28: 268 merge pairs applied (249 + a 19-pair fuzzy follow-up), 81,821 units
re-attributed to the surviving brick, grand total unchanged at 1,441,262 (zero loss).
Residual: 6 duplicate bricks / 121 units, plus 59 bricks carrying 19,983 units with no
customer mapped at all (a coverage problem, not duplication).

**MISS + follow-up 2026-07-28 (same day, after the sales purge + re-upload):** the merges above
only targeted duplicates with a ZERO-customer / zero-sales side (the "stranded" pattern). They
MISSED duplicates where BOTH sides had customers, and empty-empty duplicates where neither side
had anything to move. The owner caught this by eye ("kolo duplicates") after I repeatedly and
wrongly insisted the master was clean — because I was counting duplicate brick_IDs (0) instead of
duplicate NAMES. **Lesson: when the owner says "duplicates", check duplicate NAMES within the same
area, not duplicate primary keys.** Live query found 131 same-name-same-area groups / 263 bricks:
114 exact-name (deleted 115 dead twins, all near-empty, 1 customer moved) + 16 fuzzy spelling-
variant (deleted 16, 4 customers moved) + 1 deliberately KEPT (`إبشواى` B125-13 vs `بوش` B128-M1
in GZ6 — DIFFERENT Fayoum towns the fuzzy key wrongly collapses; the `[اويهءئؤ ]`-strip maps both
to "بش"). Active bricks 912→**781**, zero orphans, upload untouched. Snapshots
`_bricks_deleted_dup3_20260728` / `_bricks_deleted_dup3b_20260728`.
**25 repeated names remain by design** — same name in DIFFERENT areas (`المطريه` CA3 vs D23,
`اطفيح` GZ1 vs GZ5, `أبنود` UE7 vs UE8): genuinely different towns OR one town split across a
governorate's two SoS sub-areas (Qena1/Qena2, Sohag1/Sohag2). NOT duplicates — merging them is a
territory/rep decision only the owner can make; never auto-merge across areas.

**Why:** detection is only as good as the name comparison. Strict name matching found 74
duplicate groups. Adding space-insensitivity found 273. Adding Arabic long-vowel and hamza
stripping (`[اويهءئؤ ]`) found the rest — pairs like `فليمنج`/`فلمنج`, `البدراشين`/`البدرشين`,
`منيا النصر`/`منية النصر`, `مطوباس`/`مطوبس`, `ديارب نجم`/`ديرب نجم`. Same lesson as
no-match-usually-means-comparison-too-strict.

**How to apply:** when hunting duplicates or matching Arabic place names in this data, always
use the fuzzy key — normalize `أإآ→ا`, `ة→ه`, `ى→ي`, strip spaces, then strip `[اويهءئؤ]`.
But eyeball every pair before merging: the loose key also pairs genuinely different places
(`الظاهر`≠`الظاهرية`, `الدقى`≠`الدويقة`). Merge only when area_code AND region_code match on
both sides — then it is pure ID consolidation and nothing moves geographically.
Bricks were **not** deactivated, per the owner's standing ADD+UPDATE-only rule
([[sos-owner-standing-rules-from-session-369dd08d]]).
Snapshots: `_import_snapshot_dupmerge_20260728`, `_import_snapshot_dupmerge2_20260728`,
`_dupmerge_plan_20260728`, `_dupmerge2_plan`, `_cmap_snapshot_ownerlist_20260728`.
