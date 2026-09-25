---
name: forwarded-cv-split-applied-to-prod-2026-08-16
description: "The 6 staff-mailbox candidate records were split on prod 2026-08-16 — 5 real applicants extracted, 14 files correctly left behind; do not undo, and do not re-split the remaining 14."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-15T23:27:27.072Z
---

Applied to PRODUCTION (`ozucdzovmcqvepbozvqf`) 2026-08-16, owner-approved ("go ahead with the 5").
**Do NOT undo. Do NOT split the remaining 14 files.** Backup:
`candidate_split_backup_20260816` (private schema — `holders_before` 6, `files_before` 19,
`extractions_before` 18, `intake_events_before` 19).

## Why this happened at all

**A colleague's email address is a dedupe key.** `findMatchingCandidate` matches on
`national_id_norm` → `email_norm` → `phone_norm`, so every CV a Phoenix employee forwarded to the HR
inbox matched the FIRST candidate ever made from that sender's address and piled in behind it. Six
`@satopharma.com` records ended up holding **19 CV files**; `omar.anwar` alone held 9.

## 19 files were only 5 applicants — the count is the trap

Extractions are keyed **per file** (`ats_candidate_cv_extractions.file_id`), so per-file content is
readable and it does not say what the file count says:

| Split out | Not split, and why |
| --- | --- |
| Julia Nashat Youssef · `Julia.pdf` | `Dr Hany Saad RM JO.pdf`, `Nada Alii Job offer (2).pdf` — job offers **Phoenix ISSUED**, never extracted |
| Aya Ahmed Abdelazeem · `CV aya.pdf` | `page 1 ultrasound.jpeg` — a **maternity-leave** document; the email body asks HR to approve the leave |
| Mohamed Ibrahim Shabaan · `Mohamed Ibrahim.pdf` | `ymail-tmp-5013425966746647615.jpg` — the **forwarding colleague herself** (أماني أحمد + her phone) |
| Emad R. N. Morgan · `IMG_20260525_072106.jpg` | `Plan A.png` ×2 — 0 extracted fields; `IMG_20260603_150349.jpg` — no name |
| Muhammed Ahmed Tammam · `27.jpg` | **8 byte-identical duplicate uploads**: `27.jpg` ×6 more (998,785 bytes each), `Mohamed Ibrahim.pdf` ×1, `Plan A.png` ×1 |

**Always read the candidate's `notes` (the email body) before ruling on a forwarded attachment.** It
is what proved the job offers and the maternity documents — the filename and the AI's name field
both looked like applicants.

## The collision that blocks a naive split

Intake had written the **APPLICANT's phone onto the FORWARDING COLLEAGUE's record** — `youmna.kotb`
carried Aya's `01105370948`, `omargawish` carried Julia's `01275215490`. Anyone ringing the colleague
from the recruitment module reached the applicant. Because `phone_norm` carries a partial UNIQUE
index with **no trigger** behind it (see [[candidate-phone-backfill-and-the-two-traps-2026-08-16]]),
creating the applicant with her own number is rejected outright until the colleague's copy is
cleared. **Clear the holder's phone through `updateCandidate` FIRST, then create.**

## How it was done — reuse, don't reinvent

`scripts/recruitment-split-forwarded-candidates.ts` (untracked, in `_wt-recruit-simplify`) calls
`candidateIdentityFromCvFields` → `createCandidate` → `selectAutoApplyFields` → `updateCandidate`,
the same four functions inbound intake calls, then repoints `ats_files.candidate_id`,
`ats_candidate_cv_extractions.candidate_id` and `ats_cv_intake_events.candidate_id`. The five file
ids are a **hardcoded allowlist** and each is re-asserted against its holder and its extracted name
before anything moves, so a re-run cannot reach the job offers. `created === false` is treated as a
**hard stop** — a match means a merge, which is the one outcome a split must not have.

**No notification fires.** `createCandidate` inserts and returns; the only notify path in
`candidates.ts` is `pushCandidatesToManager`, which this never calls, and "new CV received" lives in
the inbound intake service, which it never enters. Measured before/after anyway: `notification_events`
6432→6432, `notification_outbox` 1660→1660, `notification_deliveries` 16896→16896,
`ats_cv_intake_events` 622→622 — **+0 on every one.**

## Verified after

Candidates **227 → 232**. `orphan_files` 0, `orphan_extractions` 0, `extraction_candidate_mismatch`
0, `intake_event_mismatch` 0, `duplicate_phone_norms` 0, `duplicate_email_norms` 0,
`phone_without_norm` 0. Each new candidate holds exactly 1 CV file and 1 intake event (Aya holds 2
extractions — that file legitimately had two).

**All 6 holder records were then set to `rejected`** with a per-record `status_note` naming what the
record actually is, plus one `ats_candidate_status_events` row each (`actor_hr_id` NULL — the actor
was an ops script under owner instruction). Status distribution is now **218 `new` · 7 `shortlisted`
· 7 `rejected`**. The 14 files stay attached to those rejected records on purpose — visibly wrong
beats invisibly wrong as junk candidates, and **no `.pdf` was deleted.**

Related: [[recruitment-intake-works-pipeline-never-used]] ·
[[intake-candidates-never-get-phone-applied]] ·
[[recruitment-candidate-migrations-applied-to-prod-2026-08-16]]
