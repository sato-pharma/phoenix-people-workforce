---
name: paramedical-is-a-field-force-exclusion-not-a-company-one
description: "Recruitment eligibility is per ROLE — a para-medical graduate is refused for Medical Rep and District Manager but is normally accepted for Office Coordinator. The paramedical shelf is a field-force verdict, not a company-wide one."
metadata:
  node_type: memory
  type: project
---

**Owner, 2026-09-02:** *"para medical is not accepted in medical rep or district manager but normally
accepted in office coordinator."*

So `paramedical` answers *"eligible for the FIELD FORCE?"* — not *"employable at Phoenix?"*. The five
disciplines in `src/lib/recruitment/candidate-background.ts` (pharmacy, science, vet, medicine,
dentistry, plus chemistry-as-science — see [[chemistry-counts-as-science-geology-excluded]]) are the
FIELD-FORCE rule. They are correct as they stand for `medical_rep` and `district_manager`, and they
must NOT be widened to admit para-medical: that would let para-medical CVs auto-file onto the two
shelves the owner just closed to them.

**Why:** the codebase currently states the exclusion in company-wide terms, so a later session reading
only the code would apply it to every seat. `candidate-folder.ts` calls the paramedical shelf *"the
only shelf nobody is hired out of"*, and the bulk-filing gate in `candidate-folder-suggestion.ts`
(`if (standing.outcome === "paramedical") … continue`) skips a candidate on the degree verdict ALONE,
without ever reading which job they applied for. Office Coordinator is a real Phoenix seat that lands
on the "Other positions" shelf, and under this rule a para-medical applicant for it is a legitimate
hire being held on an eligibility shelf that reads as a refusal.

**How to apply:** read the ROLE FAMILY before acting on a paramedical verdict. For `office_coordinator`
— and by extension the other head-office seats that resolve to "Other positions" — a para-medical
degree is not grounds to exclude, hold, or file onto the paramedical shelf. Do not answer this by
editing the eligible-discipline list; the role check belongs beside that rule, not inside it. The
verdict is computed live by `judgeBackground`, so nothing needs re-stamping — but an admin standing
already recorded as `paramedical` outranks the parser in both directions and will keep holding the
person until someone changes it by hand.
