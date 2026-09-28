---
name: chemistry-counts-as-science-geology-excluded
description: "Which DEGREES are eligible for the field force (Medical Rep, District Manager): the five disciplines are pharmacy, science, VETERINARY, medicine, dentistry — plus chemistry folded into science. Geology is deliberately excluded. Read this before treating any degree as paramedical or as an open question."
metadata: 
  node_type: memory
  type: project
  originSessionId: 740bdda2-506d-4f2a-a34c-9e2b9322b1d9
  modified: 2026-09-27T18:26:35.052Z
---

A **chemistry** graduate is an ELIGIBLE field-force background, folded into the `science` discipline
in `src/lib/recruitment/candidate-background.ts` (the `DISCIPLINE_PATTERNS` science entry matches
`chemist\w*` and the Arabic `كيمياء`). Live in production 2026-08-31 via PR #2832 (merge `a22009a38`).
It is NOT a sixth code and NOT a row in the applicant's WhatsApp "What did you graduate in?" question —
it reads as `science`, auto-filable. Chemistry CVs were being missed because they name the DEPARTMENT
("Chemistry", "Chemistry Department", "Department of Chemistry") rather than "Faculty of Science", so
the old matcher never saw the word "science".

**Geology is DELIBERATELY EXCLUDED.** It was in the very same batch of missed CVs and is equally a
Faculty-of-Science department, but the owner named CHEMISTRY ONLY (2026-08-31: *"add chemistry to be
approved with pharma vet science."*). A joint "Chemistry and Geology" department still reads eligible —
chemistry wins, inclusive direction. Pure geology stays paramedical/unknown and waits for a human. The
adjective **"chemical"** (Chemical Engineering) also stays out — it is engineering, not chemistry.

**Why:** the chemistry/geology split looks like an inconsistency and is exactly the kind of thing a
later session would "fix" by adding geology or by making chemistry its own code. It is neither — it is
the owner's explicit, narrow decision.

**VETERINARY IS SETTLED AND IS NOT AN OPEN QUESTION — re-confirmed by the owner 2026-09-27** (*"veterinary
counts as science, not paramedical"*), which changed nothing: `vet` has been one of the five eligible
disciplines since 2026-08-31, is tested FIRST in `DISCIPLINE_PATTERNS` so "Veterinary Medicine" can never
be misfiled as `medicine`, and production already held 46 veterinary graduates. A session asked him
anyway on 2026-09-27, about a real District Manager applicant whose faculty was already stored as
`Veterinary` — the cost of reading only the paramedical rule (see [[paramedical-is-a-field-force-exclusion-not-a-company-one]])
and not the eligible-discipline list. **Never put a degree to him as an eligibility question without
first reading `DISCIPLINE_PATTERNS` and the candidate's own stored `faculty` / `declared_background`.**

**How to apply:** never extend the eligible set to geology (or widen `chemist\w*` to `chemical`) without
the owner asking; when re-judging queued CVs, chemistry is eligible and needs NO write — the verdict is
computed live by `judgeBackground`, and `background_confirmed_outcome` is the ADMIN's column, never a
place to stamp an auto-eligible. Related: the eligible set is five disciplines (pharmacy, science, vet,
medicine, dentistry) plus chemistry-as-science.
