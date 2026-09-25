---
name: cv-file-is-in-ats-files-not-cv-external-url
description: "ats_candidates.cv_external_url is empty for every candidate — the CV file is a row in ats_files keyed by candidate_id, so reading that column makes every candidate in the pool look like it lost its CV"
metadata: 
  node_type: memory
  type: project
  originSessionId: e33bc510-fa9c-48dd-9f02-36e8d91f528d
  modified: 2026-08-29T20:58:45.632Z
---

**`ats_candidates.cv_external_url` is not where the CV lives, and it reads as catastrophe.**
Measured on production 2026-08-29: every candidate created that day returned empty on that column —
`wafaa elsayed`, `Mostafa Kamel Ragab`, `HANIN HAMED`, `Shrouk Mohamed Hassan`, `Walaa Mahmoud
Mohamed Ali`, `ASMAA EL-SAYED MOHAMMED SHAHEEN`, `HABIBA SAMIR`. The same eight candidates each had
**exactly one row in `public.ats_files` keyed by `candidate_id`**, carrying the real filename
(`Habiba Samir CV.pdf`, `walaa khalil.pdf`, and so on).

**Why this is dangerous rather than merely wrong.** The obvious column name is the empty one, and a
query built on it does not error — it returns a clean, confident `NO FILE` for the entire pool. On
the night this was found, the owner had just said he believed CVs were being lost, so the wrong
column would have *confirmed his fear with fabricated evidence*: eight real CVs, all safely stored,
reported back to him as eight losses. Nothing about the output looks like a bug.

**How to ask the question properly.** Join, and count:

```sql
select c.full_name, count(f.id) as files, max(f.file_name) as a_file
from public.ats_candidates c
left join public.ats_files f on f.candidate_id = c.id
group by c.id, c.full_name
```

A candidate with `files = 0` is a genuine finding. A candidate with `cv_external_url` null is not a
finding at all — it is the normal state of every row in the table.

Related: [[whatsapp-intake-counts-are-not-applicant-counts]] (the other half of the same false-alarm
pattern on this channel — a number that looks like proof and is an artefact of how it was counted),
[[capture-evidence-was-dead-on-arrival-for-doctor-customers]] (zero usage and zero reach look
identical until you exercise the path).
