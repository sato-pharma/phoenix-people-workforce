---
name: cv-extraction-never-applied-to-candidate-columns
description: "Inbound CV intake persists a full AI extraction to ats_candidate_cv_extractions but NOTHING ever reads extracted_fields back — 34/34 intake rows unapplied in prod. Design gap since day one, not a regression."
metadata: 
  node_type: memory
  type: project
  originSessionId: 921d1375-61d2-478a-b3a2-ff74afc6525e
  modified: 2026-07-31T19:56:14.021Z
---

Verified 2026-07-31 against PRODUCTION Supabase (`ozucdzovmcqvepbozvqf`, read-only) plus full git history.

**Intended design is MANUAL apply, and it is explicit.** `src/lib/recruitment/cv-extraction.ts` header:
"This module never writes to ats_candidates itself — the caller reviews/corrects the proposal and
saves it via updateCandidate()". Migration `20260723175328` comment: `applied_fields` is "what Talent
Acquisition actually saved after reviewing". The ONLY writer of `applied_fields` is
`recordAppliedExtractionFields()`, called from exactly one place: `PATCH
/api/recruitment/candidates/[id]` when the body carries an `extractionId`.

**The gap:** `ingestInboundCv` (cv-intake-service.ts) calls `persistCvExtraction` and then *discards*
the fields. Nothing in the codebase ever SELECTs `extracted_fields` for display — the only reader,
`cv-extraction-analytics.ts`, filters `.not("applied_fields","is",null)`, which excludes every intake
row by construction. The three review-board UIs (CvExtractionPanel, BulkCvExtractionPanel, profile
"Extract from CV") all get their fields by POSTing `/cv-extract`, which runs a **brand-new OpenAI
call**. So enriching an inbound candidate means paying OpenAI twice for the same CV, and nothing
tells HR there is anything to review (`notifyTalentAcquisitionOfInboundCv` links to `/recruitment`
generically).

**NOT a regression.** `git log -S"updateCandidate" -- src/lib/recruitment/inbound/` returns zero
commits. Original intake commit `44d4aaf8` already only called `extractCandidateFieldsFromCv` and
threw the result away. PR #1357 (`9c9edb10`) says it outright: fullName/email/phone "were just read
~40 lines too late, and only ever written to the review table" — that PR fixed only those 3, only
for the bulk-import `identitySource: "cv"` path (`candidateIdentityFromCvFields`). The other 9
Medical Rep fields were never wired.

**Prod numbers:** 41 extraction rows / 2 applied. 34 have `created_by IS NULL` — the intake
signature, because `systemAccessContext.hrId` is null (permissions.ts) — and 0 of those 34 are
applied. Those 34 hold ~141 non-empty values (14 university, 16 governorate, 12 address, 16
medical-rep judgment, 5 with all of university+faculty+governorate). All 72 candidates come from
email/whatsapp; exactly 2 have university/faculty/governorate — the 2 manually applied ones.
Side effect: `/recruitment/cv-extraction-analytics` computes accuracy from a sample of 2.

**How to apply:** the cheap correct fix is to SURFACE the stored extraction (read the latest row into
`getCandidateProfile`, pre-load the existing review board, deep-link the notification) — no AI spend,
no auto-write, HR still approves. Auto-applying high-confidence fields to NULL columns is a separate,
higher-risk change to HR data that needs its own owner approval per AGENTS.md. Related:
[[recruitment-cv-viewer-and-extraction-accuracy-2026-07-26]] (open branches on extraction *accuracy*,
a different problem), [[whatsapp-cv-bulk-import-forwarding]].
