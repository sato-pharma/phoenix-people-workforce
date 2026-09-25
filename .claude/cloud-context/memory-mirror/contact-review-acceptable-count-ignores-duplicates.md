---
name: contact-review-acceptable-count-ignores-duplicates
description: 'Contact Reviews "acceptable in one click" count never checks whether the value is already taken — 163 of 229 were duplicate records, and merging them shrank the pool 581 to 426'
metadata: 
  node_type: memory
  type: project
  originSessionId: bebc6e30-f573-438d-aa57-d72a715f973d
  modified: 2026-08-24T07:10:00.000Z
---

Run against production 2026-08-24 with the owner's approval: the Contact Review queue offered
**251 waiting / 229 acceptable in one click**. Accepting all 229 through `applyContactProposals`
gave **66 applied, 0 skipped, 163 FAILED**, every failure a 23505 on the app-maintained `_norm`
dedupe index — "Another candidate already has that National ID, email, or phone."

Nothing was corrupted. `updateCandidate` fails atomically per row, so the 163 were untouched and the
queue simply went 251 to 185. Verified against the pre-run backup
`ops_backup.ats_candidates_contact_20260824` (581 rows): email 322 to 375 (+53), phone 268 to 330
(+62), exactly what the run reported.

**The number is the finding.** Of the 163, **0 would ever apply cleanly** — 154 collided on email,
125 on phone — and they mapped onto only **84 distinct existing candidates**. They were duplicate
applications from the same person, not missing contact details.

**Resolved the same day: the owner said "merge the 163 duplicates".** A read-only classifier bucketed
every pair first; **155 merged, 0 failed**, pool **581 to 426**, 0 orphaned applications or files.
The 8 held back all failed one gate — the names do not agree. The owner then read them and approved
**six spelling variants** by name (a missing space, an Arabic full name against its English short
form, a dropped given name); those merged too — **6 of 6, 0 failed, pool 426 to 420** — leaving the
two real hazards alone:
`AYA MOHAMED MAHMOUD -> Radwa Mohamed Elsayed Awaga` (different people sharing a contact) and
`Pending CV Review -> HR Yasmeen Elsafory` (a placeholder name; the contact belongs to the HR
forwarder, not the candidate). Merging all 163 unattended would have DELETED a real candidate into a
stranger's record — `mergeCandidates` deletes the duplicate row, so a wrong pair is unrecoverable.

**Why:** `proposeContactDetails` gates on provenance and on the column being blank — high
confidence, one address, one diallable number — but never asks whether that value already belongs to
someone else. So "acceptable in one click" counts rows the database will refuse. The 23505 is the
index doing its job, and the code comment already predicted it: "a duplicate to merge, not a value
to force in".

**How to apply:** never quote the queue's acceptable count as work that will land — roughly 70% of
it here was duplicate records. Before promising a number, join the proposal against `email_norm` /
`phone_norm`. When merging in bulk, classify first and require the names to agree; a shared phone
number is NOT evidence of the same person. See
[[a-duplicate-merge-strands-the-desk-validation-on-the-retired-row]] for what a merge leaves behind,
and [[the-medical-rep-cv-schema-reads-12-fields-universal-reads-38]] for the never-raw-SQL rule on
these three columns.
