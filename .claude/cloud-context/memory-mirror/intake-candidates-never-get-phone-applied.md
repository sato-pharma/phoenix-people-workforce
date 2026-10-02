---
name: intake-candidates-never-get-phone-applied
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: selectAutoApplyFields will happily write a 22-digit phone ... Gate 5 isSingleDiallablePhone is applied to phone/whatsapp and is LIVE on prod; AUTO_APPLY_NEVER_KEYS excludes only the name/email, not phone (see `candidate-name-fix-and-field-apply-prod-2026-08-16`). Older text follows: An email-intake candidate keeps the sender's name and a NULL phone by design — identity fields are excluded from BOTH auto-apply and the review queue"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T05:43:31.074Z
---

An `ats_candidates` row created by inbound intake keeps **`full_name` from the email sender's
display name and `phone` NULL**, even when the AI read the real name and phone off the CV at `high`
confidence. Measured on production 2026-08-14: **0 of 117** candidates with `source='email'` created
since 2026-08-01 have a phone.

Everything else high-confidence **is** written automatically by `selectAutoApplyFields`
(`src/lib/recruitment/cv-auto-apply.ts`) — address, governorate, university, employer, experience
dates — and that write deliberately does **not** stamp `applied_fields`.

**Why:** `CV_IDENTITY_FIELD_KEYS` = `{fullName, email, phone}` is excluded from auto-apply because
`createCandidate` owns identity — it picks between the CV's identity and the sender's *before* the
row exists and derives the `national_id_norm`/`email_norm`/`phone_norm` dedupe keys from that
choice. Re-applying identity later could rewrite an **existing** candidate that intake *matched*
rather than created, silently repointing someone else's record. `cv-review-queue.ts` imports the
same set and applies the same exclusion.

**How to apply:** never "fix" a NULL phone on an intake candidate as if extraction had failed —
open the extraction row first; the value is in `extracted_fields`. And do **not** tell the owner to
apply the name or phone from the CV review queue: **the queue does not offer identity fields at
all.** The only route is a direct profile edit (`PATCH /api/recruitment/candidates/[id]`, or
`updateCandidate`), and it is only safe when the intake event's outcome was `candidate_created`
rather than `candidate_matched` — check that first, then check the phone doesn't already exist on
another row.

When doing that edit, pass **no** `extractionId`, so `applied_fields` stays NULL. It is the "a human
reviewed this extraction" signal that `cv-extraction-analytics.ts` diffs against `extracted_fields`;
stamping it with the two identity fields would make the ten auto-applied ones read as human
rejections. Contrast [[scanned-pdf-cvs-were-silently-dropped]], a genuine drop — there no extraction
row exists at all.
