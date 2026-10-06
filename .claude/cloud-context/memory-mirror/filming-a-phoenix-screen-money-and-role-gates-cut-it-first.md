---
name: filming-a-phoenix-screen-money-and-role-gates-cut-it-first
description: "before filming or demoing any Phoenix screen, read the source for TWO gates: a form that carries salary (the Employee Master's person form holds base/basic/gross/net) and a report that is role-scoped to the field force (Employee 360 excludes HR, Finance, CEO, admin and office ENTIRELY, so a plain employee is absent even from their own copy). Both cut a screen that looks obviously right"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T05:39:44.370Z
---

Found 6 Oct 2026 while building video 03 of the *Inside Phoenix* series, which was specified as
"open her record in the admin shell, then open her own copy on her phone". **Both halves were
unfilmable, and neither was visible from the route name.** Related:
[[the-staging-mask-renamed-people-per-row-not-per-person]] (the consistency gate),
[[the-nav-catalog-is-not-the-rendered-sidebar]].

**Gate 1 — a list is not its form.** `/employees` (the Employee Master) is safe as a LIST: its
seven columns are Employee Information · Hiring Date · Organization · Direct Manager · Payout ·
Contact Details · Actions, and "Payout" renders `salaryPaymentMode` — the words *"two parts"*,
never an amount (`src/components/employees/employee-management.tsx:2819-2825`, `:2926-2937`).
**Opening a person loads a form holding `baseSalary`, `basicSalary`, `grossSalary` and
`netSalary`** (`:156-279`). The owner's rule is no salary figure on screen ever, even masked — so
the obvious shot is the forbidden one, and the filmable substitute is the list filtered to one row.

**Gate 2 — "open to every role" in the nav is not open to every role on the page.** The portal
nav row for Employee 360 is ungated and commented *"Open to every role, self-scoped"*. The report
itself covers exactly six field-force families and *"every other job title — HR, Finance, CEO,
admin, office, etc. — is deliberately excluded from the report entirely"*
(`src/lib/employee-360/roles.ts:1-13`). A-1 Nour Hassan is an Admin Assistant, so she is absent
from the admin index AND from her own portal copy — "not even to themselves". Swapping in a
Medical Rep does not rescue it: a rep's 360 is built on their own **sales**, which is gate 1 again.

**How to apply:** before promising a screen, open the page file and the service behind it. Ask
(a) does this view, or anything it opens, render money? and (b) is the person I am filming inside
the view's own scope — not just the nav's? A route existing and a nav row pointing at it prove
neither. `/employee-portals/profile` was the right screen all along: hire date, reporting manager,
line, department, probation status, and the system's own sentence *"Your profile is read-only. HR
can update your contract, area, manager, or contact details."*
(`app/employee-portals/profile/page.tsx:148, 184-188, 325`).
