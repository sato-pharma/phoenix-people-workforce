---
name: the-medical-rep-cv-schema-reads-12-fields-universal-reads-38
description: "A CV read under position_key medical_rep captures only 12 fields vs universal's 38 — it never asks for a job title, so 141 candidates can only ever be judged as medical reps"
metadata:
  node_type: memory
  type: project
---

**The CV extraction schema is chosen per position, and `medical_rep` is a much narrower net than
`universal`.** Measured on production 2026-08-24 across every candidate's latest extraction:

| Schema | Candidates | Distinct fields captured |
| --- | --- | --- |
| `universal` | 398 | **38** |
| `medical_rep` | 141 | **12** |
| none at all | 11 | 0 |

`medical_rep` captures only: address, email, faculty, fullName, governorate,
hasMedicalRepExperience, hasPriorWorkExperience, medicalRepEmployer, medicalRepExperienceFrom,
medicalRepExperienceTo, phone, university.

**It never asks for `currentJobTitle`, `currentEmployer`, `yearsExperience`, `professionalSummary`,
`degree`, `graduationYear`, `dateOfBirth`, `nationality`, `militaryStatus`, `expectedSalary`,
`workHistory` or `educationHistory`.** Confirmed by the consequence, not just the schema: all **141**
`medical_rep` candidates have `current_job_title` NULL — 0 exceptions — while 223 of the 398
`universal` ones have one.

**Why this matters:** a candidate read under `medical_rep` is **structurally invisible for every
other role**. Nothing in their record says what job they hold, how senior they are, or how long they
have worked. They cannot surface in a search for a district manager, a supervisor, or anything else,
however good the CV is. This is not a data-quality problem to be backfilled — the values were never
extracted, so there is nothing on file to copy from. Compare
[[cv-extraction-reads-governorate-but-never-applies-it]], which WAS a backfill problem because the
values existed and were simply never written.

**How to apply:**
- **All 141 still have their CV file** (`ats_files` join returns 141/141), so they are recoverable by
  re-reading with the `universal` schema. That is an AI call per CV — it costs money, so it is the
  owner's decision, not an automatic repair.
- **A re-read only helps once [[cv-extraction-reads-governorate-but-never-applies-it]] is fixed
  (PR #2359).** Before that fix, re-reading extracts all 38 fields and writes none of them to the
  candidate — the work is billed and thrown away. Order matters: ship the fix first, re-read second.
- **The narrow schema tracks the EMAIL channel.** 131 of the 141 arrived by email; WhatsApp intake
  used `universal` for 324 of its 334. So the channel a CV arrives through silently decides how much
  of it is ever read.
- Do not "fix" this by pointing everything at `universal` without asking. The narrow schema is
  cheaper per CV and the rep pipeline is the high-volume one; whether the extra fields are worth the
  cost is a business call.
