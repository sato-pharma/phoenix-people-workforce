---
name: an-empty-cv-extraction-is-the-designed-answer-to-a-non-cv
description: "An empty CV extraction is usually the model saying 'this is not a CV', not a failed read. The verdict is stored in ats_candidate_cv_extractions.is_cv (#2271) and shown as a 'Not a CV' badge (#2274). Check the column before re-reading anything."
metadata:
  type: project
---

**Every field null is an ANSWER, not a failure.** `runPass` in
[cv-extraction.ts](src/lib/recruitment/cv-extraction.ts) asks one question with two halves — *is
this a CV?* and *extract these 38 fields* — and `CV_EXTRACTION_CLASSIFICATION_PREAMBLE` tells the
model verbatim: *"Set is_cv=false for anything else … and in that case the extracted fields may be
left null."* So on a photographed certificate the model answers `is_cv: false`, nulls all 38, and
finishes in **6–8 seconds**. A fast empty read is the tell.

**Before 2026-08-21 that verdict was computed and thrown away.** `persistCvExtraction` wrote six
columns — `ai_model · candidate_id · created_by · extracted_fields · file_id · position_key` — and
`is_cv` was not one of them, while the column existed with **418 rows, 0 populated, 418 NULL**. So
"the model found nothing" and "the model says this is not a CV" looked identical on every screen,
and the same thirteen images were re-read **three separate times at full vision price** hunting a
fault that never existed. See [[whatsapp-import-images-return-nothing-from-vision]].

Fixed in two halves, same day:
- **#2271** writes `is_cv` on insert and reads it back on `getLatestCvExtraction`
  (`StoredCvExtraction.isCv: boolean | null`). Migration `20260821143000_…` already applied to prod.
- **#2274** surfaces it — an amber **Not a CV** pill in the pool's *Applying for* cell, on the
  mobile flag row, and in the profile panel beside **Read the CV again**, the button that paid for
  the re-reads. Copy and the `isNotACv` guard live in `src/lib/recruitment/not-a-cv.ts`.

**Backfilled 2026-08-21 ~12:50 Cairo, and the pool is NOT fully populated.** Shipping the badge
showed on exactly ONE row, because nothing backfills: the 23 certificates were re-read at 11:50,
*before* #2271 merged at 12:00, so their verdict was still NULL. I set `is_cv = false` on those 23
extraction rows by id (all verified first: newest row per candidate, all still NULL, all read by
`gpt-5.4`, **all 0 fields extracted**), guarded with `AND is_cv IS NULL`. Undo is the same 23 ids
back to NULL. **395 older rows still read NULL and always will** — the badge is correct on them
(no judgement on record), not broken.

**The gate fires live and unprompted.** A real intake at 12:44 the same day — subject *"Apply for
Hr personal Eslam Mostafa"* — came back `is_cv: false` with one field read: `fullName = "Data
Modeling and Architectu re"`. A course certificate, caught by the pipeline itself, no re-read spend.

**Gate on `=== false`, NEVER on `!isCv`.** NULL means "nobody judged this file" — the state of every
row written before #2271, since nothing was backfilled — and treating those as not-a-CV paints a
warning across most of the pool. Same rule the file's own comment states, and the same trap
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]] is about: absent is not a no.

**Why:** an unexplained blank row reads as a broken pipeline, and the reflex is to spend money
re-running it. **How to apply:** when a candidate looks like a failed extraction, query
`ats_candidate_cv_extractions.is_cv` for that candidate FIRST. `false` means stop — the file is a
certificate or a letter and no amount of model spend will change that. NULL means genuinely no
judgement, and only then is a re-read worth anything. Confirm by downloading the bytes and looking
at the image; do not ask the owner to forward one ([[never-hand-back-a-manual-step]]).
