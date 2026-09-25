---
name: a-duplicate-merge-strands-the-desk-validation-on-the-retired-row
description: "Merging a duplicate marketing customer moves the pharmacy links but NOT validation_status — the survivor stays pending and silently drops out of every marketing-request dropdown."
metadata: 
  node_type: memory
  type: project
  originSessionId: bff71bec-334f-49ec-bffd-9c2bc986f841
  modified: 2026-08-23T20:31:16.485Z
---

**A duplicate merge moves the links and leaves the validation behind.** Marketing customer merges
are hand-written SQL, not an app feature — there is no code path to fix, so the next merge will do
it again unless the person running it carries `validation_status`, `validated_by_hr_id` and
`validated_at` across by hand.

Found 2026-08-23 in prod `ozucdzovmcqvepbozvqf`. The 2026-08-21 merge retired
`MKT-HCP-20260816-F585A5F4` (Reda Solimany, `sfe_validated` by B-10 at the desk on 2026-08-16) into
survivor `ROI-C-7986552D8DC1` (رضا سليمان — same doctor, Latin vs Arabic script, see
[[duplicate-customer-scan-misses-transliteration-and-cross-line]]). Links moved; the validation did
not. The survivor sat at `pending` with `validated_by_hr_id` NULL for two days.

**Why: `pending` is invisible, not merely unvalidated.** `service.ts` (`resolveMarketingValidation
RecordStatus`) states the rule outright — a `pending` customer never reaches the marketing-request
customer dropdown. That is the whole point of the desk flow. So the merge did not just lose an audit
column, it took a doctor the owner had personally approved and made him unselectable, with no error
anywhere. Repaired that day; survivor is now `sfe_validated` / B-10.

**The same merge wrote no audit row at all.** The only trace was free text in `validation_notes` —
the [[marketing-badge-read-a-frozen-note-not-the-live-evidence]] shape again: a note standing in for
the real column. The 2026-08-22 merge of محمد رويشة *did* audit itself properly, so coverage is
inconsistent merge to merge, not uniformly absent.

**How to apply:** before retiring a duplicate marketing customer, read the retired row's
`validation_status`/`validated_by_hr_id`/`validated_at` and carry the strongest of the two forward to
the survivor; then write an `audit_logs` row for the deactivation. After any merge, check
`validation_status='pending' and validated_by_hr_id is null` on the survivor. Do not backdate
`validated_at` — set it to the moment of the repair and put the original time in the note.

Related: [[marketing-system-validated-means-no-human-looked]] ·
[[marketing-venue-evidence-was-writable-only-at-insert]] · [[how-to-attribute-a-production-write]]
