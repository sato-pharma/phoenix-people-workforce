---
name: cv-extraction-reads-governorate-but-never-applies-it
description: "A CV RE-READ DOES gap-fill the candidate card since #2359 (2026-08-23) — high confidence, blank column only, human edit always wins; re-verified on 82 CVs 2026-09-04. `applied_fields` stays null and is NOT the writer, so never diagnose from it. Backfill of the ~2,032 historical values completed 2026-08-24 — but it covered 22 fields and DELIBERATELY skipped email/phone/national_id, so its `still_fillable: 0` never applied to them; email backfilled separately 2026-09-05 (240 rows, WhatsApp 38% → 84%)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 35733eeb-8954-457f-9b00-465671a5e235
  modified: 2026-09-04T23:59:52.674Z
---

**`applied_fields` is NOT the writer — do not diagnose from it.** It means "a human reviewed and
saved this one" and is deliberately left unwritten by every unattended path
(`cv-intake-service.ts`, `contact-review-service.ts`, and now the re-read). Reading `5 applied of
614` as "the code drops everything" is the wrong conclusion and was drawn once, on 2026-08-23,
before the real split was found.

**The real fault: `extractCandidateFieldsFromCv` in `cv-extraction.ts` — the RE-READ path** behind
the per-candidate "re-run extraction" button and every bulk re-read — persisted its extraction and
returned, applying nothing. Correct while a review queue existed to collect the proposals; **that
queue was removed 2026-08-15** (opened for 5 of 194 CVs). After that a re-read wrote to
`extracted_fields` and stopped there permanently. **Inbound intake auto-applies correctly and always
did.** Fixed 2026-08-23 in #2359 by reusing `selectAutoApplyFields` unchanged.

**How the split was found — the diagnostic that works.** Model looked causal and was not:

| model | candidates | high-conf university read | on the row |
| --- | --- | --- | --- |
| `gpt-5.4` | 37 | 33 | **33** |
| `phoenix-rules` | 101 | 74 | **0** |
| `gpt-5.4+rules` | 62 | 56 | **0** |

The actual discriminator is **`extraction.created_at - candidate.created_at`**: every failing row
was extracted **65–80 hours later** (a bulk re-read), every working row within seconds (intake).
`phoenix-rules+ocr` applying nothing is CORRECT by design — OCR marks every value `low` on purpose.

**The field is NESTED.** `extracted_fields->>'governorate'` returns the literal JSON
`{"value": "Cairo", "confidence": "high"}`. The real read is
`extracted_fields->'governorate'->>'value'`, with `->>'confidence'` as `high`/`low`. The obvious
`->>` form silently matches nothing.

**Still recoverable from existing extractions** (high confidence, blank column, latest extraction
per candidate — measured 2026-08-23 AFTER the governorate backfill): degree 172, professional
summary 169, graduation year 169, university 156, faculty 130, current job title 105, address 104,
has-medical-rep-experience 87, linkedin 85, years experience 69, current employer 51, whatsapp 8,
national id 3 — **~1,300 values**. The #2359 fix applies these only on the NEXT re-read; the
backlog needs a deliberate backfill.

**Governorate was backfilled 2026-08-23** (owner asked): 189 blanks filled, 18 spellings normalised,
coverage **164 → 353 of 550 (30% → 64%)**. 121 extractions carried `value: null`; one read
`North Lebanon` and was left alone ([[recruitment-egyptian-nationals-only]]).

**Free text fragments the search — normalise before filtering.** Sohag was stored four ways
(`Sohag`, `Suhag`, `SUHAJ`, `Sohage`), Minya three, Beheira three; Cairo and Giza also in Arabic.
**Three of the six qualifying Upper Egypt candidates were invisible to a `Sohag` search** until the
spellings were merged — including a District Sales Manager with 12.5 years already marked
`shortlisted`, for the one vacant DM seat in the company
([[master-map-sheet-live-on-prod-2026-08-17]] holds that seat's detail).

**How to apply:** candidates have **no FK to a requisition**
([[ats-candidate-children-one-has-no-fk-and-one-is-a-view]]), so `governorate` is the main way to
match a candidate to a vacant seat's territory — which is why this gap cost real hiring reach, not
just tidiness.

**Backfill completed 2026-08-24 on production (`ozucdzovmcqvepbozvqf`).** The historical damage is
repaired: **2,032 values across 23 columns** written onto 550 candidates from the extractions that
already held them (189 governorates in the first pass, then 1,843 across the remaining 22 fields).
Verified by re-running the identical "fillable" probe afterwards — **every field returned
`still_fillable: 0`**, so the extraction rows and the candidate records now agree completely.

Biggest gains, filled → % of the 550 candidates: `has_prior_work_experience` 465 (85%),
`university` 391 (71%), `has_medical_rep_experience` 351 (64%), `professional_summary` 290 (53%),
`graduation_year` 289 (53%), `degree` 287 (52%), `address` 249 (45%), `faculty` 231 (42%),
`current_job_title` 223 (41%).

**How it was done safely, and how to repeat it:**
- **`to_jsonb(c)->>col` is what makes a set-based backfill possible.** SQL cannot take a dynamic
  column name, but casting the candidate row to jsonb lets one `(jkey, col)` VALUES list drive both
  the count probe and the targeting guard for all 22 fields at once. Assignment still needs an
  explicit `CASE` per column.
- **Never write `national_id`, `email` or `phone` by raw SQL here.** `ats_candidates` has **no
  triggers at all** (checked `pg_trigger`), and the only unique indexes are
  `recruitment_candidates_{email,national_id,phone}_norm_uidx` on the derived `_norm` columns. Those
  are maintained by app code alone, so a raw write fills the visible column and leaves the dedupe
  index blind. `whatsapp` has no `_norm` column and is safe.
- Guard on `nullif(btrim(col),'') is null` for text and plain `is null` for booleans — `false` is a
  real answer to `hasPriorWorkExperience`, not a blank.
- Validate every typed value BEFORE casting, in its own probe query. Here 112/112 dates, 287/287
  years, 133/133 numerics and 10/10 phones passed, so nothing aborted the statement; a single bad
  string would have rolled back the whole batch.
- `whatsapp` got the same single-diallable gate the code applies (10–13 digits, or 14 starting
  `0020`) so SQL and `selectAutoApplyFields` cannot disagree.
- **Do NOT put several UPDATEs to `ats_candidates` in one statement as separate data-modifying
  CTEs.** They would target the same rows, and Postgres leaves the result of two updates to one row
  in a single statement undefined. Two statements, or one statement setting all columns.

Business payoff: **18 candidates in Upper Egypt now carry confirmed medical-rep experience**, four
already at manager level — RAMY ASAAD (District Sales Manager, Amazon Pharma, 12.5 yrs,
`shortlisted`), Ibrahim Ahmed (District Manager, Falcon Pharma), Moataz Mohammed (district sales
manager) and Mohamed Shehata Abd El-Gawad (CNS Supervisor, Delta Pharma). They were unreachable by
any search before, because the columns a search reads were empty while the CVs held the answers.
That matters for the one genuinely vacant DM seat, see [[master-map-sheet-live-on-prod-2026-08-17]].

**SHIPPED TO PRODUCTION 2026-08-24, 00:22 Cairo.** PR #2359 squash-merged as `fd230cfd`; Railway
deployed it in ~2m20s and `/api/healthz` returns
`revision: fd230cfdecd75d2cff6c9c4ea44f1378e0ab64d6`. The merge commit carries exactly three files —
`src/lib/recruitment/cv-extraction.ts` (+42/-1), `tests/cv-reread-applies-what-it-reads.test.ts`
(+84) and the `tests/run-tests.ts` wiring (+7) — and the source at that ref was read back to confirm
`selectAutoApplyFields`, `updateCandidate` and `candidateWasCreatedByThisIntake: false` are actually
in the shipped file, not just in the diff. A re-read now writes what it finds.

## Re-verified 2026-09-04, and the one CV that can never be read

Re-read of the 82 candidates who had **never** been read by a model (`--include-rules-only
--force-model`, ~$0.35, 20.3 min). 81 read, 0 empty, 1 failed. The gap-fill above was confirmed
live rather than assumed: **52 employers and 58 medical-rep verdicts on candidate cards now match
the NEW reading and differ from the prior one**, and each card's `updated_at` lands within 0.3 s of
its own extraction row. 18 candidates went from *unjudged* to *confirmed medical rep*.

**The conservative gate is real and visible.** 12 employers the model returned at `low` confidence
were correctly NOT written — the values were junk (`Egypt`, `In Progress`, `I have been working
in`, `27 years of experience in sales and business`). A blank column after a re-read is often the
gate working, not a miss.

🔴 **A CV whose extracted text contains a NUL byte can NEVER be read, and the error is disguised.**
Postgres refuses `\u0000` in `text`/`jsonb`, so `persistCvExtraction`'s INSERT throws **`22P05`
"unsupported Unicode escape sequence" / `\u0000 cannot be converted to text`**. The whole function
throws before the candidate write, so nothing is half-applied — but the candidate keeps **zero
extraction rows**, stays in the never-read set forever, and every re-run fails identically.
`scripts/recruitment-reread-never-read-cvs.ts` prints it as **`FAILED unexpected: [object Object]`**
— a Postgres error object has no `name`/`stack`, so the script's stringifier yields nothing usable
and the cause is invisible from the log. To see it, call `extractCandidateFieldsFromCv` directly and
print `JSON.stringify(err, Object.getOwnPropertyNames(err))`. Live case: **Abd Ulrahim Ahmed Abass**
(`66cdbb28-9003-4e17-858b-953667167ca1`), a 181 KB PDF that downloads fine. **The fix is to strip
`\u0000` from the extracted field values before persisting** — no sanitiser exists anywhere in the
extraction path today (checked `cv-extraction.ts`, `cv-extraction-fields.ts`, `cv-text-layer.ts`).

**The script's own header comment is STALE and says the opposite of what the code does.** Lines
30–41 of `scripts/recruitment-reread-never-read-cvs.ts` state *"It does NOT update ats_candidates"*
and *"applying the extracted values onto a candidate is a SEPARATE, later decision"*. That was true
before #2359 and is now false — `extractCandidateFieldsFromCv` auto-applies. The header is what a
session reads to decide whether the run is safe to fire, so believe the code, not the comment.

## The 2026-08-24 backfill's "every field `still_fillable: 0`" NEVER covered email — 2026-09-05

🔴 **That verification is true of the 22 fields it touched and silently false of the three it was
forbidden to touch.** The same section above rules out writing `email`, `phone` or `national_id` by
raw SQL, so the backfill excluded them — but the closing proof reads as though nothing anywhere is
left fillable. It is the strongest-sounding sentence in this file and it is the one that let **310
candidates sit with an email on their extraction and a blank column on their record for 12 more
days.** When quoting a `still_fillable: 0`, name the columns it ran over.

**The shape of the miss.** An email ARRIVAL hands Phoenix the sender address for free (222 of 223 =
99% populated); a WhatsApp arrival does not, so the address must come off the CV — and there the
apply step had never run. The extraction had FOUND an email for **507 of 521** WhatsApp candidates
while only 199 carried one. **The owner spotted it from the sheet** ("every cv shows an email"), and
he was right.

**Email is writable in bulk, but only with its `_norm` twin and only after three exclusions.**
`ats_candidates` still has no triggers and `email_norm` is no generated column — the app writes it
in TypeScript (`normalizeEmail` in `src/lib/recruitment/candidate-matching.ts` is exactly
`trim().toLowerCase()`, confirmed against all 421 pre-existing rows). So one statement sets
`email = <as written on the CV>` and `email_norm = lower(trim(...))` together. What must come out
first, because `recruitment_candidates_email_norm_uidx` is UNIQUE and one bad row aborts the whole
batch:

| excluded | rows | why |
| --- | --- | --- |
| value is not an email at all | 28 | the reader returned prose or a fragment |
| already owned by a different candidate | 5 | possible duplicate PERSON — never merge on a script's say-so |
| two candidates read as sharing one email | 11 | same |
| **written** | **240** | well-formed, high confidence, unclaimed |

**Result, production `ozucdzovmcqvepbozvqf`:** 240 written, all 240 verified equal to the work order
with `email_norm` matching the app rule, **zero** duplicate norms table-wide afterwards. WhatsApp
coverage **199 → 439 of 521 (38% → 84.3%)**, overall **421 → 661 of 745 (56% → 88.7%)**. Pre-image
kept at `ats_backup_20260905.candidate_email_backfill` (it doubles as the work order — the UPDATE
joins to it, so it can only touch rows already captured). Every prior value was NULL: nothing was
overwritten. The 44 exclusions went to the owner as a dropdown workbook.

⚠ **`extracted_fields->>'email'` returns the JSON OBJECT, and a validity check on it says every row
is malformed** — the nested-field trap above, in its most misleading form: `malformed: 310` reads as
*the extraction is producing garbage, there is nothing to recover*, when in fact 284 of them held a
clean address one level down at `->'email'->>'value'`. Same trap, opposite conclusion to the
governorate case, because here the wrapper still parses as a non-empty string.

**A merge is never a backfill.** The 5 + 11 conflicts decide that two records are one PERSON. That
goes through `candidate-merge-service.ts`, which rewrites both dedupe columns deliberately — never a
REST patch, and never inferred from a shared address.

## A phone clash check MUST use the app's Egyptian fold, not digits-only — 2026-09-05

`normalizePhone` (`src/lib/recruitment/candidate-matching.ts`) keeps digits, then folds ONE
ambiguity: `EGYPT_MOBILE = /^(?:00)?(?:(?:20)?0|20)(1\d{9})$/` rewrites an Egyptian mobile to
`20` + the 10 digits, so `01002106382` and `201002106382` are the SAME handset. Every other shape is
left exactly as written, deliberately.

A duplicate check written as plain `regexp_replace(v,'[^0-9]','','g')` therefore reports **0 clashes
where there are 2** — the local and international spellings never meet. It was wrong in exactly that
direction here before the fold was applied. `phone_norm` carries NO unique index (dropped
2026-08-15), so nothing in the database catches the error: the write succeeds and the duplicate
simply never surfaces in Contact Review.

The SQL equivalent, needed for any backfill:

```sql
case when substring(d from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$') is not null
     then '20' || substring(d from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$')
     else nullif(d,'') end   -- d = regexp_replace(phone,'[^0-9]','','g')
```

`isSingleDiallablePhone` is the separate SHAPE gate: 10–13 digits, or 14 starting `0020`. It is what
refuses `01224911211 & 01060650815` (22 digits, two numbers in one field) — a real row here.

## A blank email on a CV candidate is now a DUPLICATE MARKER, not a gap — 2026-09-05

After the 240-row backfill, 16 candidates were left where the CV stated an address at high
confidence and the column was still empty. **All 16 were duplicates**, in two shapes:

- **5 clash with an existing candidate** who already holds that address — and the name pairs make the
  duplication obvious (`Upper Egypt district Manager Saleh Bakry` / `saleh bakry`;
  `Taha Ramadan C V y` / `TAHA RAMADAN`; `Aya Mohamed Mahmoud HR Operations` / `AYA MOHAMED MAHMOUD`).
- **11 form 5 groups sharing one address inside the batch itself** — the same CV arriving twice or
  three times (`chahinchahin10200@gmail.com` × 3).

So **zero** were safe to write. A clash-with-existing check ALONE is not enough: it passes all 11 of
the within-batch group, and `email_norm`'s partial UNIQUE index would then abort the whole statement.
Check BOTH — against the table and within the candidate set — before any email backfill.

The useful reading is the inverse one: once the high-confidence backfill has run, **a remaining blank
email is a signal that the row is a duplicate**, not that the reader failed. Two of the 16 were not
candidates at all — `Pending CV Review` carried `yasmeen.elsafory@gmail.com`, the HR forwarder's own
address, which is the `the-email-import-allowlist-holds-an-inbox-not-a-sender` trap landing on the
candidate record itself.

## The nested keys are camelCase, and a scalar can CONTRADICT its own history — 2026-09-12

🔴 **The trap above has a second half that cost two wrong PRODUCTION decisions.** The nesting rule is
already written here; what is not is that **the keys do not match the column names.** The candidate
column is `graduation_year`, the extraction key is **`graduationYear`**; `years_experience` is
**`yearsExperience`**. So the snake_case read returns NULL for every row — and NULL reads as *the CV
never said*, which is the most dangerous wrong answer available, because it retires the question.
It was quoted to the owner as "neither extraction ever read a graduation year or experience" about a
candidate whose CV stated both at HIGH confidence. Column names are snake_case, extraction keys are
camelCase; never infer one from the other.

🔴 **`graduationYear` and `yearsExperience` are DERIVED and can disagree with `educationHistory` /
`workHistory` INSIDE THE SAME EXTRACTION ROW.** Both live cases, both on 2026-09-12:

- **Wafaa El-Sayed Mostafa Ebaid** — `graduationYear: 2026` at HIGH, while that row's
  `educationHistory` holds `2026 MBA (Arab Academy)` **and** `2009 Faculty of Science, Ain Shams,
  "Graduation (June - 2009)"`. The 2026 is a master's she is **starting**, not a graduation. Her
  record read as a 2026 graduate; she has been working since June 2009.
- **Eslam Mostafa EL-Sayed** — `graduationYear: 2026` at HIGH in the same row whose
  `educationHistory` says **2023**. Self-contradictory within one extraction.

**So `educationHistory[].year` and `workHistory[].from` are the evidence; the scalar is a summary of
them and loses the distinction between a degree AWARDED and one BEGUN.** Read the history arrays
before acting on either scalar, and check `medicalRepExperienceFrom` against `yearsExperience` —
Wafaa's 4.8 came from a LOW-confidence rules pass reading her start as 2017 (one job of five); the
AI pass read 2009-06 and returned 17.2, which is arithmetically exact.

🔴 **A value that LOOKS incoherent is not evidence that it is wrong — and "defending a signal" is
how a correct fix gets reverted.** Two of four rows reverted on 2026-09-12 should have been left
alone, both because a pairing looked impossible (17.2 years against "graduated 2026") when the
implausible half was the OTHER field. Same shape on **Ahmed Nasr M. Sheta**: a title rewrite
`Chemist / Medical Representative` → `Chemist` was reverted to preserve his only medical-rep signal,
but `workHistory` held ONE job (Chemist, lab duties), `hasMedicalRepExperience` was **false** in both
reads, and the summary never mentions rep work — the signal was a self-description, not a job.
**Open the CV's structured history before flagging an extraction change, every time.**
