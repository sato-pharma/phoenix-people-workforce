---
name: intake-candidates-never-get-phone-applied
description: "An email-intake candidate keeps the SENDER's name (fullName is never auto-applied), but its phone is NOT null by design any more: since 2026-08-15 a high-confidence CV phone IS auto-applied when this intake CREATED the candidate and it is one diallable number (gate 5, isSingleDiallablePhone); email joined 2026-09-05. On a MATCHED candidate phone/email still wait for a human — check the extraction row and the intake outcome before touching a NULL phone."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-10-02T16:37:09.636Z
---

An `ats_candidates` row created by inbound intake keeps **`full_name` from the email sender's
display name** even when the AI read the real name off the CV at `high` confidence. **Its phone is
auto-applied from the CV** when the extraction is `high` confidence, this intake **CREATED** the
candidate (not matched an existing one), and the value is ONE diallable number (gate 5).
Measured on production 2026-08-14 — before that change — **0 of 117** candidates with `source='email'`
created since 2026-08-01 had a phone.
**Superseded 2026-10-02:** previously "an intake candidate keeps a NULL phone by design" — `phone` moved
into on-create-only auto-apply on 2026-08-15 (`email` followed 2026-09-05), with gate 5 live on prod since
2026-08-16 ([[candidate-name-fix-and-field-apply-prod-2026-08-16]], `src/lib/recruitment/cv-auto-apply.ts`).

Everything else high-confidence **is** written automatically by `selectAutoApplyFields`
(`src/lib/recruitment/cv-auto-apply.ts`) — address, governorate, university, employer, experience
dates — and that write deliberately does **not** stamp `applied_fields`.

**Why:** `createCandidate` owns identity — it picks between the CV's identity and the sender's *before*
the row exists and derives the `national_id_norm`/`email_norm`/`phone_norm` dedupe keys from that
choice. Re-applying identity later could rewrite an **existing** candidate that intake *matched*
rather than created, silently repointing someone else's record. So today only `fullName` is never
auto-applied (`AUTO_APPLY_NEVER_KEYS = {fullName}`); `email` and `phone` are
`AUTO_APPLY_ON_CREATE_ONLY_KEYS` — written only when `candidateWasCreatedByThisIntake` is true — and
`phone`/`whatsapp` must also pass `isSingleDiallablePhone` (`PHONE_SHAPED_KEYS`), because a CV's
"Contact" line can hold two numbers run together.
**Superseded 2026-10-02:** previously "`CV_IDENTITY_FIELD_KEYS` = `{fullName, email, phone}` is excluded
from auto-apply, and `cv-review-queue.ts` applies the same exclusion" — that set is gone from `src/`, and
`cv-review-queue.ts` was deleted on 2026-08-16 (#2162).

**How to apply:** never "fix" a NULL phone on an intake candidate as if extraction had failed —
open the extraction row first; the value is in `extracted_fields`. A NULL phone today means the reading was
`low` confidence, the intake MATCHED an existing candidate, gate 5 refused a multi-number value, or the
candidate predates 2026-08-15. For those, the route is a direct profile edit
(`PATCH /api/recruitment/candidates/[id]`, or `updateCandidate`), and it is only safe when the intake
event's outcome was `candidate_created` rather than `candidate_matched` — check that first, then check the
phone doesn't already exist on another row.

When doing that edit, pass **no** `extractionId`, so `applied_fields` stays NULL. It is the "a human
reviewed this extraction" signal that `cv-extraction-analytics.ts` diffs against `extracted_fields`;
stamping it with the two identity fields would make the ten auto-applied ones read as human
rejections. Contrast [[scanned-pdf-cvs-were-silently-dropped]], a genuine drop — there no extraction
row exists at all.
