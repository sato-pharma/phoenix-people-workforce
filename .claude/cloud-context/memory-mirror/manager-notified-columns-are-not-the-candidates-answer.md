---
name: manager-notified-columns-are-not-the-candidates-answer
description: "ats_candidates.manager_notified_region/area/job_title describe the MANAGER who was notified, not what the candidate applied for — writing a candidate's own answer there corrupts the hiring-manager notify feature"
metadata: 
  node_type: memory
  type: project
  originSessionId: e095ef1e-a48a-4780-ab5a-fb0c8e34528a
  modified: 2026-10-01T00:00:00.000Z
---

**`manager_notified_region`, `manager_notified_area` and `manager_notified_job_title` on
`ats_candidates` are NOT the candidate's declaration.** They are written by
`src/lib/recruitment/hiring-manager-notify.ts` from `manager.regionName`, `manager.areaName`
and `manager.jobTitle` — the territory and title of the **hiring manager who was pinged about this
candidate**. `src/lib/recruitment/db.ts` reads them straight back out under a `manager`
object.

The names read exactly like "which region did this candidate apply for", which is why this is worth
a memory: on 2026-08-28 they were about to be used as the storage for a candidate's self-declared
region and area, which would have silently overwritten the notify trail on every classified
candidate.

**Where a candidate's own answer actually goes:**

- **Job title -> `applied_for_job_title`.** This is correct and load-bearing: it is the TOP rung of
  the ladder in `src/lib/recruitment/applied-for.ts` ("a human typed it. Always wins"), so filling
  it lights up the whole "Applying for" column with no new read path.
- **Region/area -> `preferred_region_code` / `preferred_area_name`, with
  `preferences_declared_at`.** Added 2026-08-28 (PR #2495) because nothing existing fits.
  `governorate` is geography an extractor read off the CV, not a stated preference.

**How to apply:** before writing any `ats_candidates` column whose name suggests it holds an
applicant's intent, grep for its writer. Several columns on that table are records of what the
SYSTEM did about a candidate, not statements the candidate made. Related:
[[a-cv-import-overwrote-a-candidates-whole-identity]] and
[[optional-field-written-unconditionally-is-a-silent-erase]].
