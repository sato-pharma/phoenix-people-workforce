---
name: guamusin-spec-is-the-corrected-sheet
description: "Guamusin's specification is `xlsx/Guamusin-data-checked.xlsx` — the owner's own filled workbook WITH the five data-entry corrections found in it, accepted by his \"follow the sheet i uoploaded 100%\" on 2026-10-08; its last open input, the aluminium film, was answered the same day at 0.018 kg per box of 12 (stored as 18 g, `per_box`), so Guamusin now has no missing input."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-08T18:37:46.041Z
---

Guamusin (جواموسين) is the Production Planner's second product, seeded 2026-10-08: a powder in 5 g
sachets, a **fixed** 100 kg batch, 12 sachets to a carton, toll-manufactured by DBK Pharma, 6 runs
ordered (= 600 kg = 120,000 sachets = exactly 10,000 cartons), no free samples.

**The specification is `xlsx/Guamusin-data-checked.xlsx`, not the file he uploaded.** He filled in the
data-request workbook; five data-entry faults were found in his copy and corrected, and he sent the
corrected sheet back with **"follow the sheet i uoploaded 100%]"** — so those five corrections are
accepted and that file, not his original, is what the migration seeds. `xlsx/` is gitignored, so the
sheet itself is not in the repo; the migration
(`supabase/migrations/20261008190000_production_planning_guamusin.sql`) carries every figure from it
and `tests/production-planning-guamusin.test.ts` reproduces each "Need for 6 runs" cell from the
migration's own per-dose values.

**The aluminium film was the last open input, and he answered it on 2026-10-08.** He sent DBK's own
table headed **Quantity Aluminum / box** reading `0.018`, and confirmed the basis when asked: 0.018
kg per box of twelve. `20261008234500` opens its formula line as `per_box` **18 g** — grams, because
every composition in this module stores base units, and `0.018` written raw would ask DBK for
eighteen grams for the whole order. Six runs is 10,000 boxes, so **180 kg**, against 230.95 kg at
DBK: that order buys no film.

🔴 **The 16,667 beside his 0.018 is BOXES PER RUN, not stock** — he said so when asked, and the
geometry agrees: a 100 kg run is 20,000 sachets, which is 1,666.7 boxes (the crop lost the decimal).
Read as a holding it would have implied 300 kg and overwritten a correct 230.95. Nothing about the
stock changed.

So Guamusin has **no missing input left**; the lemon flavour's per-dose figure remains Ivyronc's.

Waste and overage are deliberately empty too: every Guamusin composition row carries an explicit
`overage_pct = 0` rather than a null, because a null would inherit the 3% default and he asked for
the waste figure left alone until a real run measures one.

The module's rules, the four latent defects a second product exposed, and the expiry alarm:
`.claude/rules/production-planning.md` and `docs/production-planner-guamusin.md`.
