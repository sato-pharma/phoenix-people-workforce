---
name: ats-candidates-full-name-holds-the-whole-intake-envelope
description: "40% of ats_candidates.full_name rows store the forwarder's entire email envelope, not a name — up to 185 chars, which is what broke the candidate pool layout"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5f6e15e1-d34d-44e7-957b-76b67e0453b9
  modified: 2026-08-21T09:03:28.498Z
---

`ats_candidates.full_name` is not reliably a name. Measured on production 2026-08-20, 555 rows:

- **220 rows (40%)** hold the forwarder's whole envelope — attachment filename, sender, and email
  subject in one string:
  `"file 754C9140 8AD3 404A 8339 AFC0892A9BFF From(Islam Mostafa (islam most3011@gmail com)) Subject(Apply for Hr)"`
  Average 100+ characters, longest **185**.
- The other **335** hold a real name: p95 **28** characters, longest 40.
- The sender inside `From( … (` is the reliable extraction: it resolved **220/220** with zero
  failures, longest result 33 chars. It is not always spelled the way the CV spells it (one row's
  filename says "Mohamed Dawood" where the sender says "Dawood Dawood"), so the stored value is
  never overwritten — `src/lib/recruitment/candidate-display.ts` derives it for display only.

Other measured shape of the same table, all from that snapshot: **97%** status `new`, **97%** no
`applied_for_job_title`, **46%** no email, **57%** no phone, **132 rows** flagged
`possibleDuplicate`.

**Why:** a single 185-character cell with `whitespace-nowrap` was wider than the screen — that, plus
eight controls per row in the actions cell, is what made the candidate pool scroll sideways with
eight-line-tall rows. Two rounds of width-capping (#2232) changed nothing, because a narrower cell
just wraps the same content onto more lines. The rebuild is #2235.

**THE OWNER'S RULE FOR A JUNK NON-APPLICANT IS: DELETE IT.** Asked three separate times on
2026-08-21 he chose deletion every time — the two envelope records, then the three vendor
solicitations — so **do not propose annotate-and-reject for an outside sender whose record holds
nothing worth keeping.** The older annotate-and-reject pattern in the data (6 of 553 rows
`rejected`, every one carrying a note, 5 written by hand on 16 Aug 2026 naming the real CVs *split
out* of them) still governs the **5 internal `@satopharma.com` mailbox records** — those are
deliberately kept, and must never be deleted blind, because `omar.anwar` still holds 8 files and
`omargawish` 6, including real applicants' CVs.

**Full non-applicant census, production 2026-08-21 (subjects + attachments reviewed for all 171
distinct intake subjects, 605 events, 551 candidates):**

- **Already triaged, keep as-is — 5:** `amany.ahmed`, `omar.anwar`, `omargawish`, `sara.jacoub`,
  `youmna.kotb`, all `@satopharma.com` staff mailboxes the intake keyed on the *sender*.
- **Vendor solicitations — 3, DELETED 2026-08-21 on the owner's instruction:**
  `Ahmed Al.shazly <medicatrainingcenter@gmail.com>` (sales-training vendor, 3 subjects: "Does your
  sales team reflects your company strength?", "Empower sales team", "العائد على الاستثمار مع
  التدريب والتطوير"); `Dr. Ahmed Alshazly <alshazly.ahmed79@gmail.com>` (**same person, second
  address**, "sales challenges & success plans"); and `Souter Scales <souterscales@yahoo.com>`
  ("قيد موردين موازين" — a scales supplier asking to be entered in the supplier register, company
  name in `full_name`). Each one's own `notes` body states the pitch outright, which is the cheapest
  proof; all three were `status = 'new'`, unnoted, and had never reached `ats_applications`. The
  delete took 6 `ats_files` and 4 extractions with it and nulled 6 intake-event pointers.
- **Real people whose only file is an OUTBOUND company document — 4:** Abdelrahman Nour, dr.hany
  saad, Khaled Abdelfatah (signed/issued job offers) and Marina Gamal (an 11 KB Outlook signature
  image off an interview-confirmation reply). **These are not junk records — do not delete them** —
  but they will never yield CV data. See [[whatsapp-import-images-return-nothing-from-vision]].
- **`Emad R. N. Morgan` — CONFIRMED A DOCTOR'S PRESCRIPTION, DELETED 2026-08-21.** The owner opened
  `IMG_20260525_072106.jpg` and it is a prescription, forwarded inside
  `sara.jacoub@satopharma.com`'s *maternity-leave* thread. The AI had read the **clinic letterhead**
  — name `/high`, phone, `governorate = Alexandria`, `address = "475 طريق الحرية - بولكلي"` (Bolkly,
  Alexandria) — and `ops:forwarded-split-20260816` promoted that into its own candidate. It had put
  a **third-party physician's practice details into the recruitment database**, sourced from an
  employee's medical paperwork.

**THE CHEAPEST TELL THAT A FILE IS A LETTERHEAD, NOT A CV: the extraction returns a NAME AND
NOTHING ELSE** (or a name plus only contact details). A real CV yields phone *and* education *and*
experience; a certificate or prescription yields the one name printed on it. Query
`extracted_fields` for rows whose only non-null keys are `fullName` (± `phone`/`address`) before
trusting that a split-out record is a person who applied.

- **STILL UNRESOLVED, same fingerprint — `Muhammed Ahmed Tammam` (`0cb5e580`).** Split out of
  `omar.anwar` from the subject **"Certificate of Attendance - Pharmacy Promotion & OTC Campaign"**,
  one file `27.jpg`, and the AI could read **`fullName` and absolutely nothing else**. That reads as
  an attendee named on a training certificate. It is contradicted by `omar.anwar`'s own hand-written
  note, which calls `27.jpg` a CV photo and Tammam "the applicant on that photo" — so a human who
  looked disagreed with this inference. **Do not delete it on the fingerprint alone; open the file.**

**Worse than a bad name — some rows are not applicants at all, and their "CV" is not a CV.** The
email intake makes a candidate out of *any* attachment reaching the HR mailbox, with
`ats_files.kind = 'cv'` regardless of what the file is. Two confirmed on production 2026-08-21 and
**deleted** that day: `Daftra Sales <sales@daftra.com>`, whose two 2.1 MB "CVs" were the vendor's
own price quotation (subject *"Re: طلب عرض سعر وتوضيح آلية التعاقد"*), and
`Automated <automated@satopharma.com>`, whose two "CVs" were a 108 KB PNG of the **staff insurance
benefits table** (subject *"Medical Insurance & Life Protection Benefits 2025/2026"*). Both were
created 2026-07-24 by the same intake run; one had already been hand-triaged to `rejected` with the
note "Not an applicant". **So an all-null AI extraction is sometimes the model being right**, which
is live evidence for the open question in
[[whatsapp-import-images-return-nothing-from-vision]] — check what the attachment actually *is*
before blaming the vision path.

**THE INTAKE WAS NEVER THE HOLE — `scripts/recruitment-split-forwarded-candidates.ts` WAS.** Email
intake has had a CV gate since ~2026-07-28 (`cv-intake-service.ts`, on the model's `is_cv`) and it
demonstrably works: **43** attachments suppressed in prod through 2026-08-18, all logged
`ignored_unsupported_attachment`. Every junk record deleted on 08-21 was created **2026-07-24**,
before that gate ever fired. The real bypass is the split script, which builds candidates out of
files that ALREADY EXIST and so never touches intake; its only content guard re-asserted the
extracted **name** (`identity.fullName !== split.expectName`), and a prescription has a name on it.
**FIXED AND LIVE — PR #2271, merged 2026-08-21 12:00 Cairo, squash `3f3c0e05`, `/api/healthz`
confirmed `revision: 3f3c0e0580f244cd908cf97935237c7660ed594b` 80s later.** `is_cv` is now persisted
on `ats_candidate_cv_extractions` (it was computed and thrown away, so nothing downstream of intake
could ask the question) and the split script refuses a file the read judged not to be a CV. **Every reader gates on an EXPLICIT `false`; NULL
means no judgement was recorded and must never be read as "not a CV"** — the 394 rows written before
that date are all NULL, and failing closed on them would discard real applicants. Migration applied
to prod by hand ahead of the merge ([[railway-deploy-applies-no-migrations]]).

**How to apply:** never assume a recruitment row's `full_name` is short or is a person's name, and
never assume a row is a job applicant or that its `kind = 'cv'` file is a CV. Any new surface that
renders the name needs `candidateDisplayName()` and a bounded width, and any dedupe or matching on
that column has to cope with envelopes. Deleting one of these is safe and well-bounded: the only FKs
into `ats_candidates` are `ats_applications`, `ats_candidate_cv_extractions` and `ats_files` (all
`ON DELETE CASCADE`) plus `ats_cv_intake_events` (`ON DELETE SET NULL`, so the "this email arrived"
audit row survives with null pointers), and the file bytes live in Drive under
`ats_files.drive_file_id` and are never touched. Related:
[[whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate]],
[[intake-candidates-never-get-phone-applied]], [[recruitment-intake-works-pipeline-never-used]].
