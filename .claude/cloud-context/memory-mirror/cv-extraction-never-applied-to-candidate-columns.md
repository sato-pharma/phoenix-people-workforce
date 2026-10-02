---
name: cv-extraction-never-applied-to-candidate-columns
description: "Inbound CV intake's AI extraction was once discarded (34/34 intake rows unapplied, 2026-07-31). Since PR #1516 (merged 2026-07-31, owner decision) high-confidence column fields AUTO-APPLY as gap-fill at intake — live behaviour, not a proposal; applied_fields stays reserved for human reviews."
metadata: 
  node_type: memory
  type: project
  originSessionId: 921d1375-61d2-478a-b3a2-ff74afc6525e
  modified: 2026-10-02T16:33:40.162Z
---

Verified 2026-07-31 against PRODUCTION Supabase (`ozucdzovmcqvepbozvqf`, read-only) plus full git history.

**🔴 CURRENT STATE: inbound intake AUTO-APPLIES high-confidence fields.** Owner decision
2026-07-31, PR #1516 MERGED 2026-07-31 and verified live in production: `cv-intake-service.ts`
applies the extraction already in hand (no second AI call) through `src/lib/recruitment/cv-auto-apply.ts`
— `confidence === "high"` only, schema `storage === "column"` fields only, never the identity triple,
gap-fill only (never overwrite). `applied_fields` is deliberately NOT written by auto-apply — it stays
the "a human reviewed this" signal. A review queue (PR #1526) surfaces the rest for Talent Acquisition.
Full account: [[cv-extraction-auto-apply-high-confidence]]. Everything below is the 2026-07-31
pre-merge diagnosis that led to it.
**Superseded 2026-10-02:** previously "nothing ever reads extracted_fields back; auto-apply would need its own owner approval" — the owner approved it 2026-07-31 and PR #1516 shipped it ([[cv-extraction-auto-apply-high-confidence]]).

**The original design (before #1516) was MANUAL apply, and it was explicit.** `src/lib/recruitment/cv-extraction.ts` header:
"This module never writes to ats_candidates itself — the caller reviews/corrects the proposal and
saves it via updateCandidate()". Migration `20260723175328` comment: `applied_fields` is "what Talent
Acquisition actually saved after reviewing". The ONLY writer of `applied_fields` is
`recordAppliedExtractionFields()`, called from exactly one place: `PATCH
/api/recruitment/candidates/[id]` when the body carries an `extractionId`.

**The gap (as of 2026-07-31, before #1516 — now CLOSED):** `ingestInboundCv` (cv-intake-service.ts) called `persistCvExtraction` and then *discarded*
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
(Those 39 pre-existing unapplied extractions were backfilled the same night with the auto-apply
gates, owner-approved: 65 field writes across 16 candidates — see
[[cv-extraction-auto-apply-high-confidence]].)

**How to apply:** high-confidence fields now auto-apply to NULL columns at intake — do not re-propose
it as a pending change, and do not "fix" `applied_fields` by writing it from the auto-apply path or a
backfill (it is the analytics' human-review signal). Low-confidence and non-column fields still wait
for a human: surface the stored extraction (no AI spend), and let Talent Acquisition approve it
through the review queue / `PATCH /api/recruitment/candidates/[id]` with `extractionId`.
**Superseded 2026-10-02:** previously "auto-applying high-confidence fields to NULL columns is a separate change needing its own owner approval" — the owner approved it 2026-07-31 and PR #1516 merged it ([[cv-extraction-auto-apply-high-confidence]]). Related:
[[recruitment-cv-viewer-and-extraction-accuracy-2026-07-26]] (open branches on extraction *accuracy*,
a different problem), [[whatsapp-cv-bulk-import-forwarding]].
