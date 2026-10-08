---
name: guamusin-spec-is-the-corrected-sheet
description: "Guamusin's specification is `xlsx/Guamusin-data-checked.xlsx` — the owner's own filled workbook WITH the five data-entry corrections found in it, accepted by his \"follow the sheet i uoploaded 100%\" on 2026-10-08; the one input still outstanding is the kilograms of aluminium sachet film per 1,000 sachets, which only DBK has."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-08T16:34:40.421Z
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

**Still outstanding from him: the kilograms of aluminium sachet film per 1,000 sachets.** Only DBK
knows it and he did not have it on 2026-10-08. Until he does, `SACHET_FILM_ALU` has stock and a price
but **no composition row**, so it never reaches the buy list — and a guessed figure must never be put
there, because it arrives as a real number in kilograms against a material he actually buys. It is
Guamusin's single missing input, exactly as the lemon flavour's per-dose figure is Ivyronc's.

Waste and overage are deliberately empty too: every Guamusin composition row carries an explicit
`overage_pct = 0` rather than a null, because a null would inherit the 3% default and he asked for
the waste figure left alone until a real run measures one.

The module's rules, the four latent defects a second product exposed, and the expiry alarm:
`.claude/rules/production-planning.md` and `docs/production-planner-guamusin.md`.
