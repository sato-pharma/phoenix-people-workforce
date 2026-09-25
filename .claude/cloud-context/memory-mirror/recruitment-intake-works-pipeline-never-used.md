---
name: recruitment-intake-works-pipeline-never-used
description: "Recruitment's intake half works and its pipeline half has never been used once — free-text status is the cause, not a bug in the pipeline code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T21:55:56.980Z
---

Measured on PRODUCTION 2026-08-15: `ats_candidates` = 203 rows, **129 created in the last 7 days**
(automated email/WhatsApp intake is healthy), `ats_cv_intake_events` = 591. But
`ats_requisitions` = 2, `ats_applications` = 3, **`ats_interviews` = 0**, and 173 of 175
`ats_candidate_cv_extractions` were never human-reviewed.

**202 of the 203 candidates still read status `Candidate Created`** — the default from
`DEFAULT_CANDIDATE_STATUS`. The only other value is one sentence I typed by hand. **200 of 203 were
never linked to a requisition.**

**Why:** the candidate status was a bare free-text `<Input placeholder="Status">`, and the pool
rendered all 203 rows on one page (27,427px, ~1,443 controls) with the profile panel appended
*below* every row. A status nobody can type is a status nobody sets — so the ATS is functioning as
an inbox, not a pipeline. The pipeline code itself is not broken; nothing ever entered it.

**How to apply:** never diagnose recruitment "pipeline" emptiness as a bug in
`src/lib/recruitment/applications.ts` or the state machine — check whether anything was ever
*entered* first. Also: 92% of candidates have no phone (186/203) and 6 rows are internal
`@satopharma.com` addresses, so the pool is not clean enough to drive outreach counts. See
[[recruitment-egyptian-nationals-only]] for the eligibility rule that governs it.
