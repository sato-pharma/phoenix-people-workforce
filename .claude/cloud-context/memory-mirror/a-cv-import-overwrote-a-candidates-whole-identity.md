---
name: a-cv-import-overwrote-a-candidates-whole-identity
description: "CV intake used to treat the FORWARDER as the applicant, so every CV a staff member forwards collapses onto the FIRST record made from their number/email and can overwrite its name, phone and every profile field with a stranger's data. The code is fixed (#1357, #2345) but pre-fix rows are residue and a handset OFF the import allowlist still collapses a forwarded batch. NEVER resolve a CV by its sender — match on the extraction's own fullName/phone. A re-read will NOT repair a polluted row (gap-fill only); it takes an explicit updateCandidate with null. Two detectors, two shapes: email = distinct-sender-count >1; WhatsApp = phone_norm equals wa_id AND >1 intake event."
metadata:
  node_type: memory
  type: project
  originSessionId: bebc6e30-f573-438d-aa57-d72a715f973d
  modified: 2026-09-25T23:54:04.302Z
---

## Root cause — the forwarder became the applicant (code already fixed)

Intake used to treat the person who **forwarded** a CV as the applicant, so a colleague's WhatsApp
number or email address became a dedupe key and **every CV they forwarded matched the FIRST record
made from it.** In the worst case a bulk email import dumped 34 strangers' CVs onto one pre-existing
forwarder row and overwrote the row itself — name, phone erased, and job title, employer, university,
graduation, address, military status and `linkedin_url` all replaced with values read off strangers'
CVs. Repaired 24 Aug (stray files/extractions deleted with backups, the real owner re-extracted and
restored via `updateCandidate`); every imported file was verified to have a twin on the correct
candidate first, so **`content_lost = 0`**.

Fixed in code by **#1357 (26 Jul — build bulk imports from the CV, not the forwarder, WhatsApp +
email)** and **#2345 (23 Aug — a forwarded CV was filed under the e-mail envelope, not the person)**.
A row created **before** those fixes is residue, not a live bug. Mis-attributed Contact Review contact
proposals are a **SYMPTOM of a polluted row**, not a scoring bug
([[contact-review-acceptable-count-ignores-duplicates]]).

## The import allowlist is a TWO-WAY SWITCH — you cannot have both halves from one handset

`RECRUITMENT_EMAIL_IMPORT_SENDERS` / `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` decide how a sender is read
(`whatsapp-payload-parser.ts`, `whatsapp-classify-session.ts`):

| Sender on the allowlist? | Identity | Self-classification menus |
| --- | --- | --- |
| **YES** (forwarder) | read from the CV, `phone: null` ✅ | **never asked** (`skipped_import_sender`) |
| **NO** (direct applicant) | `phone: "+" + wa_id` stamped on the row — **every CV from that handset collapses onto ONE record** ⚠️ | asked ✅ |

The CV's own phone can never repair a collapsed row: `phone` is an `AUTO_APPLY_ON_CREATE_ONLY_KEYS`
field and gap-fill skips a column that is already set (`cv-auto-apply.ts`). So the menus reach almost
nobody while a forwarding handset is allowlisted — nearly all CVs arrive forwarded off two handsets
(the owner's 012 and an 011); only a handful ever came direct. **A bracket/menu change therefore cannot
be verified through the normal forwarding flow** — test one CV at a time and delete the record between
runs. 🔴 **Owner instruction 2026-08-28: keep the 012 OFF the allowlist and treat it as a normal
applicant number** — so a forwarded BATCH from the 012 will now collapse onto one row; warn him before
he forwards one.

A staff address not on the allowlist is read as an applicant, so **forwarder records can legitimately
sit in the candidate pool** (some deliberately, left "visibly wrong rather than invisibly wrong"); the
CVs on them almost always also exist as their own correct candidates, so nobody is lost. `.env.local`
sets neither variable, and `railway variables` cannot be read from a worktree (CLI unlinked there) —
check the allowlist from the primary checkout.

## How to work with it

- **Detect it — two shapes, two detectors.** Email bulk-import: `count(distinct sender)` per candidate,
  healthy is **1**; a polluted row reads many. WhatsApp: the sender count is 1 (one handset) yet the row
  holds strangers, so compare the candidate's `phone_norm` against `raw_metadata->>'wa_id'` on its
  `ats_cv_intake_events` — **equal AND more than one intake event = a forwarder record.** The
  broken-email-pass fingerprint is a file row with **no intake event and no `uploaded_by_hr_id`** (now 0
  across the whole table).
- 🔴 **NEVER resolve a CV by its SENDER.** Staff forward each other's applicants (Hager Tarek sent Heba
  Tarek's CV, etc.), so matching by sender produces a false "this applicant was never created" that a
  phone match **inside the CV** immediately disproves. **Match on the extraction's own `fullName`/
  `phone`, and never write a sender's address onto a candidate as their email.**
- **A re-read will NOT repair a polluted row.** `extractCandidateFieldsFromCv` auto-applies via
  `selectAutoApplyFields`, which is **gap-fill only** (blank columns), and identity fields stay excluded
  when `candidateWasCreatedByThisIntake` is false — so wrong values already present survive. Clearing
  them takes an explicit `updateCandidate` where a stated `null` clears a column and an omitted key
  leaves it untouched ([[optional-field-written-unconditionally-is-a-silent-erase]]).
- **Candidate writes are UNAUDITED** — `audit_logs` held zero rows for the polluted id, so the intake
  events were the only history. Do not expect an audit trail to tell you what a candidate row used to say.

## Phone matching — canonical `phone_norm` is DONE, don't "repair" it back

`normalizePhone` (`src/lib/recruitment/candidate-matching.ts`) folds an Egyptian mobile onto the
**international** form (the one Meta's `wa_id` sends and cannot be asked to change), and
`findMatchingCandidate` compares by exact string equality — so before this fix a local `01…` and an
international `20…` were two different people, a steady duplicate generator once direct messaging
becomes the norm. PR #2522 + migration `canonicalize_candidate_phone_norm` (prod 2026-08-28) rewrote
~265 rows onto the international form, 0 collisions; `phone` itself is untouched.

⚠ **So `phone_norm = regexp_replace(phone,'\D','','g')` is now FALSE for ~265 rows BY DESIGN** — running
that old desync check today reports a pool-wide "fault" that is the fix working. **Do not repair those
rows back to digits-only — it re-opens the duplicate bug.** The correct check is
`phone_norm = normalizePhone(phone)` (or the SQL equivalent). `email_norm = lower(btrim(email))` is
unchanged and still a true invariant. When correcting contact details by hand, write **both** the value
and its `_norm` twin in the same statement — there is **no DB trigger**, the app (`updateCandidatePayload`)
is the only writer, which is why a DB-only backfill could never hold on its own. And do NOT widen the
matcher to the 9-digit tail comparison (`phoneTailForMatch`) that only feeds the advisory duplicate
FLAGS: **false-merging two real people is worse than a duplicate**, which is why it never auto-merges.
