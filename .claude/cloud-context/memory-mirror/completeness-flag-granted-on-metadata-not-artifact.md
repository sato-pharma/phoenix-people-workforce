---
name: completeness-flag-granted-on-metadata-not-artifact
description: "A 'complete'/'validated' status column earned from METADATA (a filename, a flag) while the artifact it claims was never stored — has hit marketing evidence and outstation photos"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ce29c0-afc6-49f2-8b39-6bac5bc73651
  modified: 2026-08-04T14:01:02.101Z
---

A status column that means "proof exists" gets computed from the proof's **metadata** instead of the
proof itself, so it reads `complete` with nothing behind it. **Two separate modules have shipped this
exact bug**, so treat it as a repo-wide class, not a one-off.

- **Marketing evidence (found 2026-08-04, fixed PR #1724).** `LiveCameraModal` built a GPS-stamped
  JPEG, held it in React state for the preview, and `payloadCapture` sent only `evidencePhotoName` +
  timestamp + GPS. The bytes died on form reset. `evidenceStatusFromInput` granted `complete` on
  `Boolean(evidencePhotoName)` — a **string**. 3 production rows (1 customer, 2 pharmacies) reached
  `evidence_status='complete'` AND `validation_status='system_validated'` on unretained proof, and
  `system_validated` is what puts a customer in the marketing request dropdown. `marketing_evidence_files`
  existed, defaulted `storage_bucket` to `'marketing-evidence'`, was referenced by **zero** application
  code, and the bucket was never created — empty since it shipped.
- **Outstation.** Same shape — see the test named *"a 'complete' status with no photo behind it never
  pays"*.

**How to detect it.** Grep for a status/flag derived from a `*_name`, `*_has_*`, or `*_captured_at`
column rather than from a storage path or a row in the artifact table. Then ask the DB the blunt
question: `select count(*) from <artifact_table>` — if a table designed to hold the proof is **empty**
while the status column says `complete`, that is the bug, not a coincidence.

**How to fix it.** Make the flag require the artifact: derive `complete` from the bytes/path, abort the
whole write if the upload fails (so the record never survives its own evidence), and delete the
uploaded object if the index row fails. Then the flag means exactly "a signed URL will resolve".

**Two traps when testing it.** (1) If you also reject the bad shape at the input boundary, the inner
status rule becomes **unreachable** and a prove-it-fails break on it will silently NOT fire — export
the rule and assert it directly, or it rots untested. This happened. (2) The pre-existing test may be
**pinning the defect** — `marketing-validation-service.test.ts` asserted a filename-only fixture
normalized to `complete`, and had to be updated as part of the fix.

Related: [[no-data-must-never-render-as-absence-or-zero]] (rendering side of the same honesty rule),
[[prove-it-fails-verify-which-assertion-fired]], [[list-migrations-reports-ledger-not-reality]].
