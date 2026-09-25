---
name: a-cv-import-overwrote-a-candidates-whole-identity
description: 'The 18 Aug 2026 bulk CV import dumped 35 strangers CVs onto ONE candidate row and overwrote its name, phone and every profile field — found and repaired 24 Aug; RECURRED on WhatsApp 28 Aug where the sender-count detector is blind'
metadata: 
  node_type: memory
  type: project
  originSessionId: bebc6e30-f573-438d-aa57-d72a715f973d
  modified: 2026-08-28T06:30:07.454Z
---

Production candidate `cc764b4a-a5ea-498d-9cf4-d9a1ce769f0b` was created **25 July 2026 03:45 Cairo**
from a CV that staff member **Omar Anwar** forwarded over WhatsApp (`+201280955558`). Its two
`ats_cv_intake_events` read `candidate_created` then `candidate_matched` with
`match_reason = "phone"`, so the row carried its owner's phone at intake.

**On 18 August between 20:21 and 20:34 Cairo a bulk email import attached 34 OTHER people's CVs to
it** — 29 distinct senders — and at 20:55 overwrote the row itself: name became
`AYA MOHAMED MAHMOUD`, the phone was ERASED, and the job title, employer, years of experience,
university, faculty, graduation year, grade, address, military status and `linkedin_url` all became
values read off strangers' CVs. The LinkedIn pointed at a man named Walid Wahba.

**The real owner is `Antoin Sabry Sobhy Asaad`** — dental sales representative, Nahda University,
Oral and Dental Medicine, 2020, Tanta/Gharbia, `antoinsabry95@gmail.com`, `01289635837`. He existed
**nowhere else** in the pool. Repaired 24 August: 35 stray files and 30 stray extractions deleted
(backups `ops_backup.ats_bucket_files_20260824`, `..._extractions_20260824`,
`..._candidate_20260824`), his own 25 July CV re-extracted, and every field restored from that read
through `updateCandidate`. All 34 imported files were verified to have a twin on the correct
candidate first — **`content_lost = 0`**, nobody's CV was destroyed.

**Why it matters:** this one row is why Contact Review proposed *Radwa Awaga's* email and phone for
"Aya" — Radwa's CV was among the 34. Mis-attributed contact proposals are a SYMPTOM of a polluted
row, not a scoring bug.

**ROOT CAUSE, traced 24 Aug — the code is already fixed; this row was residue.** Intake used to
treat the FORWARDER as the applicant, so a colleague's address or WhatsApp number became a dedupe
key and every CV they forwarded matched the FIRST record made from it. `cv-import-shared.ts` says so
outright. Fixed by **#1357, 26 July — "build bulk CV imports from the CV, not the forwarder
(WhatsApp + email)"**, and again by **#2345, 23 Aug — "a forwarded CV was filed under the e-mail
envelope, not the person"**. `cc764b4a` was created **25 July, one day BEFORE #1357**, so it was
already Omar Anwar's forwarder record (its 2nd July intake event matched by `phone`) when he
forwarded 34 CVs on 18 Aug.

**The 18 Aug incident ran in TWO passes and self-corrected.** Pass 1, 20:21-20:34: files written onto
`cc764b4a`, **no intake event, no uploader**. Pass 2, 20:54-22:10: the SAME files from the SAME
sender, each `candidate_created` on its own correct candidate with a proper intake event. Only pass
1's copies were left behind. **The fingerprint of the broken pass is a file row with no intake event
and no `uploaded_by_hr_id`** — across the whole table that is now **0**.

**STILL OPEN: two staff members sit in the candidate pool as forwarder records.** `omar.anwar .`
(24 July, 8 files) is DELIBERATE — the split script left job offers Phoenix sent and a certificate
photo there "visibly wrong rather than invisibly wrong as five junk candidates". `omargawish .`
(**14 Aug — AFTER #1357**) holds **6 real applicants' CVs** (Mohamed Ibrahim Shabaan, Ahmed Samy Abu
Elmagd, Mahmoud Abdel Moneim, Alshimaa Nageh, Mina Ehab Ramzy, Rana Samy — all six DO exist as their
own candidates, so nobody is lost). The gate is the env allowlist `RECRUITMENT_EMAIL_IMPORT_SENDERS`
/ `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`: a staff address NOT on it is still read as an applicant.
Neither is set in `.env.local`, and `railway variables` cannot be read from a worktree — the CLI is
unlinked there, so check it from the primary checkout.

**How to apply:**
- **Detect it with a sender count.** `count(distinct substring(file_name from 'From[(][^(]*[(]([^)]+)[)]'))`
  per candidate: healthy is **1**. This row read 29 while every other candidate read 1. Verified 1
  across the whole pool after the repair — run it again before trusting any bulk candidate operation.
- **NEVER resolve a CV by its SENDER.** Hager Tarek sent Heba Tarek's CV; Salma Mohamed sent Mohamed
  Samy's; "Emy Ahmed" sent **EMAN ABDELNASER**'s. Matching by sender produced a false "an applicant
  was never created" conclusion that a phone match inside the CV immediately disproved. Match on the
  extraction's own `fullName`/`phone`. For the same reason never write a sender's address onto a
  candidate as their email.
- **A re-read will NOT repair a polluted row.** `extractCandidateFieldsFromCv` auto-applies via
  `selectAutoApplyFields`, which is **gap-fill only** — blank columns, and identity fields stay
  excluded when `candidateWasCreatedByThisIntake` is false. Wrong values already present survive it.
  Clearing them takes an explicit `updateCandidate` where a stated `null` clears a column and an
  omitted key leaves it untouched.
- **Candidate writes are UNAUDITED** — `audit_logs` held zero rows for this id, so the intake events
  were the only history. Do not expect an audit trail to tell you what a candidate row used to say.

See [[contact-review-acceptable-count-ignores-duplicates]] for the merge campaign this surfaced
during, and [[optional-field-written-unconditionally-is-a-silent-erase]] for the write pattern that
erases a column nobody meant to touch.

---

## 2026-08-28 — it RECURRED on WhatsApp, and the sender-count detector above CANNOT see it

Candidate `79c8adac-a045-4425-b9ee-12db5e1fa4a7` was created 03:52 UTC from a CV forwarded off the
owner's **012** (`201280955558`, display name "Omar Anwar" — the same forwarder number as the July
incident). Three documents, **two different real people**, one row: Samaa Shalaby's CV created it,
then `Nada Updated CV copy.pdf` (Nada Usama Mohamed Ibraheem, Benha University, Port Said) matched
onto it by `phone`. The row's phone was `+201280955558` — the FORWARDER's — while Samaa's own CV
said `01007915921`. Deleted 2026-08-28 after owner approval; snapshot at
`…\scratchpad\candidate-79c8adac-snapshot.json` (44,002 bytes) and the storage objects were left in
place, so both CVs are recoverable.

**The "count distinct senders; healthy is 1" rule above does not detect this shape.** Here the
sender count WAS 1 — one handset — and the row still held two strangers. That heuristic only finds
the *email* bulk-import shape, where 29 different people mailed in. **For WhatsApp, compare the
candidate's `phone_norm` against `raw_metadata->>'wa_id'` on its `ats_cv_intake_events` instead: if
they are equal AND the row has more than one intake event, it is a forwarder record.**

**ROOT CAUSE is not a bug — `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` is a TWO-WAY SWITCH, and you
cannot have both halves from one handset.** Verified in code 2026-08-28:

| Sender on the allowlist? | Identity | Classification menus |
| --- | --- | --- |
| **YES** (forwarder) | read from the CV — `phone: null`, `identitySource: "cv"` ✅ | **never asked** — `startClassification` returns `skipped_import_sender` |
| **NO** (direct applicant) | `phone: "+" + wa_id` stamped on the row — every CV from that handset collapses onto ONE record ⚠️ | asked ✅ |

Code: `whatsapp-payload-parser.ts:246-268` picks the branch; `whatsapp-classify-session.ts:272` is
`if (input.isImportSender) return "skipped_import_sender";`. The CV's phone can never repair it —
`cv-auto-apply.ts:51-52` puts `phone` in `AUTO_APPLY_ON_CREATE_ONLY_KEYS` and gap-fill skips a
column that is already set.

**Production reality measured that day:** 347 of 452 WhatsApp CVs arrived from the 012 and 91 from
the 011; only **14, from 9 senders, came direct** and none since 29 July. So **the self-classification
menus reach almost nobody while both handsets are allowlisted** — that is the design, not a fault,
but it means a bracket/menu change cannot be verified through the normal forwarding flow. The week
of 17 Aug the 012 was ON the list and 342 forwards correctly created 300 candidates; by 28 Aug it
was OFF and 3 forwards collapsed onto one row. **Owner instruction 2026-08-28: keep the 012 OFF the
list and treat it as a normal applicant number** — so a forwarded BATCH from the 012 will now
collapse. Warn him before he forwards one, and test menus one CV at a time, deleting the record
between runs.

### The phone FORM splits the pool, and it will manufacture duplicates once Coexistence is live

`normalizePhone` (`src/lib/recruitment/candidate-matching.ts:18-23`) keeps **digits only** — its comment
claims it drops "a single leading Egyptian/international 00/0 noise" but the code does **not**. And
`findMatchingCandidate` compares those keys by **exact string equality**. So `01202645759` (what a CV
prints) and `201202645759` (what WhatsApp sends as `wa_id`) are two different people to the matcher.

Measured 2026-08-28 across 448 candidates: **265 local-form `01…`, 62 international `20…`, 62 other
shapes, 59 with no phone.** WhatsApp intake always writes the international form. **So every one of
those 265 will fail to match if that same person later messages the Cloud API line directly** — the
intake creates a second candidate instead. Today that is nearly invisible because only 14 CVs have
ever arrived direct; the day Coexistence is approved it becomes the normal path, and this turns into
a steady duplicate generator.

The 9-digit tail comparison that WOULD catch it (`phoneTailForMatch`, same file, lines 92-95) is
wired only into the advisory duplicate FLAGS, which by design "never auto-merge". Do not quietly
widen the matcher to use it — false-merging two real people is worse than a duplicate. The fix, when
someone takes it, is to normalize to ONE canonical form on write and backfill, which is a migration
plus a re-key of the partial unique indexes, not a one-line change.

## 2026-08-28 — DONE. `phone_norm` is canonical now, so the desync check below CHANGED

PR #2522 + migration `canonicalize_candidate_phone_norm`, applied to production 2026-08-28 ~09:30
Cairo. `normalizePhone` folds an Egyptian mobile onto the **international** form (the one Meta's
`wa_id` sends and cannot be asked to change). Three shapes fold: `01xxxxxxxxx` (253 rows),
`00201xxxxxxxxx` (7), `2001xxxxxxxxx` (5, `+20` typed in front of the local `0`). **265 rewritten,
61 already canonical, 0 collisions**, verified row-by-row against a before-image. No re-key of the
partial unique indexes was needed — nothing collided. `phone` itself is untouched and stays in
whatever form the person wrote it. Nothing else folds: a landline, a foreign number and a bare
`1xxxxxxxxx` keep their digits, because merging two different people is not recoverable.

⚠ **So `phone_norm = regexp_replace(phone,'\D','','g')` is now FALSE for ~265 rows BY DESIGN.** That
was the desync check this file used to prescribe, and running it today reports a pool-wide "fault"
that is the fix working. **Do not "repair" those rows back to digits-only** — that re-opens the
duplicate-candidate bug. The correct check is now
`phone_norm = normalizePhone(phone)` using the real function
(`src/lib/recruitment/candidate-matching.ts`), or in SQL:
`phone_norm = coalesce('20' || substring(regexp_replace(phone,'\D','','g') from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$'), regexp_replace(phone,'\D','','g'))`.

`email_norm = lower(btrim(email))` is **unchanged** and still a true invariant.

When correcting a candidate's contact details by hand, still write **both** the value and its `_norm`
twin in the same statement — `updateCandidatePayload` recomputes `phone_norm` from `phone` on every
edit that touches the phone, and there is **no database trigger**, so the app is the only writer.
That is precisely why a DB-only backfill could never have held on its own.
