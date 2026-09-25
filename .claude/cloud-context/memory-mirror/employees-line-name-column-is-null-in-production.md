---
name: employees-line-name-column-is-null-in-production
description: "employees.line_name is NULL for every production row — the product line must be resolved from line_id via the lines table, never read from the text column."
metadata: 
  node_type: memory
  type: reference
  originSessionId: e27ce870-c05f-4ccf-b91a-38099d9562e0
  modified: 2026-08-20T12:25:17.476Z
---

`employees.line_name` exists as a `text` column but is **NULL for all 173 production rows** — it was
never backfilled. Same for `employees.department_name` and `employees.area_name`. The live values
come from the id columns: `employees.line_id` → `lines.id` / `lines.name`
(1 = Anti Infective, 2 = Pedia, 3 = CNS, 4 = a training/other line).

`probation_cases.line_name` is a **second, separate** text copy and is NULL on the newer cases
(5 of 18 open cases on 2026-08-20) — so it cannot be the only source either. Resolve
`case.line_name ?? lines[employee.line_id]`.

**Why:** a `select ... e.line_name` join looks like it works — it returns rows, just with every
line blank — so a line filter written against it silently matches nothing (or, worse, matches an
`?? ""` fallback) instead of erroring. This is why `isSameLine()` in
`src/lib/probation/service.ts` prefers the numeric `line_id` via `sameWorkforceLine` and treats the
text as a fallback only; the comment there says the old text-only comparison "missed peers whose
lineName text was stale".

**How to apply:** when you need a person's line in SQL or in a direct PostgREST `.select()`, take
`line_id` and join `lines`. In app code, prefer the employee directory's derived `lineName` (it
already resolves the id) or `sameWorkforceLine`. Never write a query whose correctness depends on
`employees.line_name` holding a value. Related: [[ahmed-sharaf-is-the-cross-line-product-manager]],
[[nsm-title-is-held-once-per-line-not-company-wide]].
