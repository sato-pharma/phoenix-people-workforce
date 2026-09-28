---
name: cv-extraction-reads-governorate-but-never-applies-it
description: "Reading a CV extraction: the field is DOUBLE-nested AND the keys are camelCase, not the column names - extracted_fields->'graduationYear'->>'value' with ->>'confidence' high/low; the snake_case ->>'graduation_year' returns NULL, which reads as 'the CV never said' and cost two wrong production decisions. A re-read DOES gap-fill the card since #2359 (high confidence, blank column only, human edit wins); applied_fields is NOT the writer, never diagnose from it. Derived scalars (graduationYear/yearsExperience) can CONTRADICT educationHistory/workHistory in the same row - read the history arrays before acting. Never write national_id/email/phone by raw SQL (the _norm dedupe index is app-maintained); phone dedupe MUST use the app's Egyptian fold; a NUL byte in a CV makes it permanently unreadable. Historical backfills (governorate, 22 fields, email) are DONE."
metadata:
  node_type: memory
  type: project
  originSessionId: 35733eeb-8954-457f-9b00-465671a5e235
  modified: 2026-09-25T23:20:17.612Z
---

## Reading an extraction — the two-part trap that keeps costing wrong answers

🔴 **`extracted_fields` values are DOUBLE-nested, and the keys are camelCase — not the column names.**
`extracted_fields->>'governorate'` returns the literal object `{"value":"Cairo","confidence":"high"}`,
never the string. The real read is **`extracted_fields->'<key>'->>'value'`** with `->>'confidence'`
as `high`/`low`. And the key is the extraction's own **camelCase** name, not the snake_case column:
column `graduation_year` → key **`graduationYear`**, `years_experience` → **`yearsExperience`**. A
snake_case `->>` read matches nothing and returns NULL — which reads as *the CV never said*, the most
dangerous wrong answer available because it retires the question. This was quoted to the owner as
"neither extraction ever read a graduation year" about a CV that stated both at HIGH confidence, and
it drove two wrong production decisions. **Never infer one casing from the other.**

🔴 **Derived scalars can CONTRADICT the history arrays inside the SAME extraction row.**
`graduationYear` / `yearsExperience` are summaries and lose the distinction between a degree AWARDED
and one BEGUN — e.g. `graduationYear: 2026` at HIGH on a candidate whose `educationHistory` shows a
2026 master's she is *starting* over a 2009 bachelor's, or a `2026` scalar over a `2023`
`educationHistory` in one row. **`educationHistory[].year` and `workHistory[].from` are the evidence;
the scalar is a lossy summary.** Read the arrays before acting on either scalar, and check
`medicalRepExperienceFrom` against `yearsExperience`.

🔴 **A value that LOOKS incoherent is not evidence it is wrong — "defending a signal" is how a correct
fix gets reverted.** An implausible pairing (17.2 years against "graduated 2026") usually means the
OTHER half is the wrong one. A `Chemist / Medical Representative` → `Chemist` correction was wrongly
reverted to "preserve a rep signal" when `workHistory` held one lab job and `hasMedicalRepExperience`
was `false` in both reads — the signal was a self-description, not a job. **Open the CV's structured
history before flagging any extraction change, every time.**

## The re-read now applies — `applied_fields` is not the writer

- **`applied_fields` is NOT the writer — do not diagnose from it.** It means "a human reviewed and
  saved this one," and every unattended path (`cv-intake-service.ts`, `contact-review-service.ts`,
  the re-read) deliberately leaves it unwritten. Reading `5 applied of 614` as "the code drops
  everything" is the wrong conclusion (drawn once, before the real split was found).
- **A re-read DOES gap-fill the candidate card since #2359 (2026-08-23):** high confidence only, blank
  column only, a human edit always wins. Inbound intake always auto-applied correctly; the bug was
  that `extractCandidateFieldsFromCv` (the re-read path) stopped writing once the review queue was
  removed 2026-08-15. Fixed by reusing `selectAutoApplyFields`.
- ⚠ **The header comment of `scripts/recruitment-reread-never-read-cvs.ts` (lines ~30–41) is STALE and
  says the OPPOSITE** — "It does NOT update ats_candidates." That was true pre-#2359 and is now false.
  Believe the code, not the comment, when deciding whether a bulk re-read is safe to fire.
- **The conservative low-confidence gate is real:** the model's `low` values (junk like `Egypt`,
  `In Progress`, a sentence fragment) are correctly NOT written, so **a blank column after a re-read is
  often the gate working, not a miss.** Diagnose the failing vs. working split by
  `extraction.created_at − candidate.created_at` (a bulk re-read lands 65–80 h after the candidate;
  intake within seconds), never by which model produced it.
- 🔴 **A CV whose extracted text contains a NUL byte can NEVER be read.** Postgres refuses `\u0000`, so
  `persistCvExtraction`'s INSERT throws `22P05`; the candidate keeps zero extraction rows, stays in
  the never-read set forever, and every re-run fails identically. The script disguises it as
  `FAILED unexpected: [object Object]` (a PG error object has no `name`/`stack`). No sanitiser exists
  in the extraction path — **the fix is to strip `\u0000` from field values before persisting.** Live
  case: Abd Ulrahim Ahmed Abass (`66cdbb28-9003-4e17-858b-953667167ca1`).

## Writing candidate columns in bulk — the dedupe rules

- 🔴 **Never write `national_id`, `email` or `phone` by raw SQL.** `ats_candidates` has **no triggers
  at all**; the unique indexes are on the derived `_norm` columns, maintained by app code alone — so a
  raw write fills the visible column and leaves the dedupe index blind. `whatsapp` has no `_norm` and
  is safe. Email IS writable in bulk, but only by setting `email` **and** `email_norm =
  lower(trim(...))` (the exact `normalizeEmail` rule) together, and only after excluding non-emails,
  rows already owned by another candidate, and rows sharing one address within the batch.
- 🔴 **A phone clash check MUST use the app's Egyptian fold, not digits-only.** `normalizePhone` folds
  one ambiguity — `EGYPT_MOBILE = /^(?:00)?(?:(?:20)?0|20)(1\d{9})$/` rewrites to `20`+10 digits, so
  `01002106382` and `201002106382` are the SAME handset. A plain `regexp_replace(v,'[^0-9]','','g')`
  dedupe reports 0 clashes where there are 2, and `phone_norm` has NO unique index (dropped
  2026-08-15) so nothing in the DB catches it. SQL equivalent for any backfill:
  ```sql
  case when substring(d from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$') is not null
       then '20' || substring(d from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$')
       else nullif(d,'') end   -- d = regexp_replace(phone,'[^0-9]','','g')
  ```
  `isSingleDiallablePhone` is the separate SHAPE gate (10–13 digits, or 14 starting `0020`) — it is
  what refuses two numbers crammed in one field.
- **A merge is never a backfill.** A shared address means two records may be one PERSON — that goes
  through `candidate-merge-service.ts` (which rewrites both dedupe columns deliberately), never a REST
  patch and never inferred from the shared value. After a high-confidence email backfill, **a
  remaining blank email is a DUPLICATE MARKER, not a reader miss** (also watch the
  [[the-email-import-allowlist-holds-an-inbox-not-a-sender]] trap landing on a candidate row).
- **When quoting a `still_fillable: 0`, name the columns it ran over.** The 2026-08-24 backfill
  covered 22 fields and was *forbidden* to touch email/phone/national_id, so its clean proof read as
  though nothing anywhere was fillable — and left 310 candidates with an email on their extraction and
  a blank column for 12 more days.

## Why this mattered, and what is already done

Candidates have **no FK to a requisition** ([[ats-candidate-children-one-has-no-fk-and-one-is-a-view]]),
so `governorate` is the main way to match a candidate to a vacant seat's territory — an empty column
cost real hiring reach, not tidiness. **Normalise free-text spellings before filtering:** Sohag was
stored four ways (`Sohag`/`Suhag`/`SUHAJ`/`Sohage`), and three qualifying Upper Egypt candidates were
invisible to a `Sohag` search until merged. A `North Lebanon` read is left alone
([[recruitment-egyptian-nationals-only]]).

**Historical backfills are DONE on production** (`ozucdzovmcqvepbozvqf`): governorate (2026-08-23),
2,032 values across 22 fields (2026-08-24), and 240 emails (2026-09-05, WhatsApp coverage 38% → 84%).
Pre-images kept in `ats_backup_20260905`. The technique if ever repeated: `to_jsonb(c)->>col` lets one
`(jkey,col)` VALUES list drive the probe and guard for many fields at once (assignment still needs a
per-column `CASE`); validate every typed value in its own probe before casting (one bad string rolls
back the batch); and never put two data-modifying UPDATEs to `ats_candidates` in one statement.
The one vacant DM seat this reach fed: [[master-map-sheet-live-on-prod-2026-08-17]].
