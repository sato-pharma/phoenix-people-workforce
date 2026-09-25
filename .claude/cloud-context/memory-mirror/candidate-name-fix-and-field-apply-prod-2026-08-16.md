---
name: candidate-name-fix-and-field-apply-prod-2026-08-16
description: "125 candidates renamed off the email sender onto the CV, and 34 enriched from their extractions — LIVE prod 2026-08-16, do not undo; selectAutoApplyFields will happily write a 22-digit phone."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-16T00:49:00.105Z
---

Applied to PRODUCTION (`ozucdzovmcqvepbozvqf`) 2026-08-16, owner-approved ("fix the names too",
"apply the names and fields when the re-read finishes"). **Do NOT undo.** Full before-state of
`ats_candidates` (232 rows) in the private schema `candidate_apply_backup_20260816`.

## The name fix is an OWNER OVERRIDE of a shipped refusal — keep it in its own script

`selectAutoApplyFields` refuses to write `fullName` (`AUTO_APPLY_NEVER_KEYS = {fullName, email}`).
Its stated reason is that both "are what createCandidate matched on" — **true of email, false of
fullName.** `findMatchingCandidate` (the LOCKED identity rule) keys on `national_id_norm` →
`email_norm` → `phone_norm` and nothing else; `fullName` appears only in `findDuplicateFlags` /
`findPossibleDuplicate`, which are "advisory only … never merges anything", and there is **no
`name_norm` column** to collide on. So a rename cannot repoint one person's record at another.
**Rewriting an EMAIL still can, and is still never done.**

`scripts/recruitment-fix-candidate-names.ts` (untracked, `_wt-recruit-simplify`). **125 renamed, 0
failed.** `Mariamgad123` → `MARIAM EMAD GAD`, `M Nasser2002` → `Mohamed Abdel-Nasser Mohamed`,
`anooo Ahmed` → `Hanaa Ahmed Ahmed Abdel-Aal`. Records whose name is a mailbox handle: **11 → 7**,
and 5 of the 7 are the rejected staff records whose handle IS their correct name.

Four guards, each load-bearing: **high confidence only**; skip when `applied_fields` carries a
`fullName` (a human saved it); skip `status = 'rejected'`; skip when the names differ only by case
or punctuation. Comparison must be **Unicode-aware** — a `[^a-z]` strip erases an Arabic name
entirely, so two DIFFERENT Arabic names compare equal and both get silently skipped.

## `selectAutoApplyFields` WOULD WRITE A 22-DIGIT "PHONE" — fixed in code, not yet shipped

It gated the phone on confidence and blankness and nothing else. Measured on this batch, **8 of 42
high-confidence phones were two or three numbers run together** — `01060464699 & 01112872565` (22
digits), `+91-7002466900/9085277771/7002031980` (32). Writing one is worse than a blank: `phone_norm`
carries it into the partial UNIQUE index and a later real dedupe fails against a value that was never
a phone number. The apply script holds them back with the same rule the phone backfill used —
**10-13 digits, or 14 starting `0020`**.

**Gate 5, added 2026-08-16**: `isSingleDiallablePhone` in `cv-auto-apply.ts`, applied to
`PHONE_SHAPED_KEYS = {phone, whatsapp}`, pinned by 17 assertions in
`tests/recruitment-cv-auto-apply.test.ts`. Both halves proven by breaking them — disabling the gate
line fires `"a high-confidence two-number string is REFUSED even on a candidate this intake
created"`, and making the helper return `true` fires `"two numbers run together"`. **LIVE on prod
2026-08-16 (#2170, `6ad15542`) — do NOT undo.** It also closes a WIDER hole:
`whatsapp` is in neither NEVER nor ON_CREATE_ONLY, so it auto-applied on a MATCHED candidate too with
no shape check at all. It is the only gate that judges the VALUE
rather than its provenance, which is precisely why the other four cannot catch this class — the AI
is not wrong, it read the page correctly.

## The field apply was widened past the re-read marker, on purpose

`scripts/recruitment-apply-reread-fields.ts` originally filtered `created_by = 'ops:cv-reread-20260816'`.
Widened to the latest extraction per candidate because ~200 candidates were read **before**
auto-apply-at-intake shipped, so their extracted values had never reached the columns. Safe because
`selectAutoApplyFields` only ever fills a **blank** column — it cannot overwrite a human edit or an
earlier extraction. It also skips `status = 'rejected'`, so the retired staff-mailbox records do not
get a university and a work history read off somebody else's forwarded CV.

**34 written, 0 failed, 7 phones held back.** Row count 232 → 232, `duplicate_phone_norm` 0 → 0,
`phone_without_norm` 0 → 0.

| Column | Before | After |
| --- | --- | --- |
| phone | 142 | **169** |
| university | 140 | **170** |
| current_job_title | 26 | **49** |
| governorate | 88 | **110** |
| nationality | 10 | **23** |
| has_medical_rep_experience | 164 | **197** |

## Two things this surfaced that are still open

* **`appliedForJobTitle` fills on only 5 of 40 re-read extractions** (5 of 241 overall — every one of
  them from the re-read, so the strengthened reader is the only thing that has ever produced it).
  Plausible rather than broken: most CVs never name a target role. **Do not trust this script's own
  "Names found" / "Applied-for" summary lines from before 2026-08-16** — they read snake_case keys
  (`full_name`, `applied_for_job_title`) against a camelCase payload and reported 0 while 35 of 40
  rows carried a name.
* **A CV forwarded by one person under another's email keeps the FORWARDER's email**, even after the
  rename. The record now reads with the applicant's name and the forwarder's address — `amr Eid` →
  `Alaa Shaker Eid`, `Donia Khalifa` → `SABAH KHALIFA`, `MIT Impex` → `Talha Yaseen`. Each holds only
  ONE CV so no split is needed, but the email is somebody else's and email is a dedupe key, so the
  real applicant applying later creates a second record.

Related: [[forwarded-cv-split-applied-to-prod-2026-08-16]] ·
[[candidate-phone-backfill-and-the-two-traps-2026-08-16]] ·
[[recruitment-intake-works-pipeline-never-used]]
