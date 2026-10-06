---
name: filming-a-phoenix-screen-money-and-role-gates-cut-it-first
description: "before filming or demoing any Phoenix screen, read the source for THREE gates: a form that carries salary (the Employee Master's person form holds base/basic/gross/net); a report role-scoped to the field force (Employee 360 excludes HR, Finance, CEO, admin and office ENTIRELY, so a plain employee is absent even from their own copy); and 🔴 MONEY HIDING IN PROSE — a payroll alert reads 'Net salary differs from employee compensation (43,000)', so a sweep for EGP or a decimal pair returns 0 of 22 and calls the screen clean. Count a bare number in a sentence as money and read the actual rows. Conversely the portal payslip page masks every figure to ****** by default, which makes it the one payroll screen that IS filmable. 🔴 GATE 4 — FREE-TEXT HUMAN REMARKS SURVIVE THE STAGING MASK: the mask renames PEOPLE, never a decision note, so an outstation approval_reason still reads 'No expense from Tanta To Mahalla Dr Rasha appreciate ur efforts' — a real manager's words naming a real doctor. A field clean in its TYPE can be dirty in its CONTENT; film an engine-written reason, never a stored one"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T07:55:10.267Z
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

🔴 **Gate 3 — MONEY HIDES IN PROSE, AND A CURRENCY REGEX CERTIFIES THE SCREEN AS CLEAN** (added
6 Oct 2026, building video 05 — payroll). `PayrollGovernanceAlerts` on `/payroll` renders
`flag.message` verbatim for the first 14 flags, and on staging those 22 messages read *"Row 12 /
Net Salary: Net salary differs from employee compensation (**43,000**); the uploaded payroll value
was preserved for payslip accuracy"* — also Gross `(50,770)`, income tax `(7,770)`,
`(16,692.5)`. A sweep for `EGP`, for `جنيه` or for a decimal-pair amount returns **0 of 22**,
because the figures are bare and unlabelled mid-sentence, so the panel was one step from being
cast on the strength of that zero. **Count a bare number in a sentence as money, and read the
actual rows rather than a pattern over them.** The same panel prints a raw HR ID, against the
names-never-codes rule. (`/payroll` is also why video 05 carries the series' only CLIPPED capture:
the page top is clean down to the workflow panel and the money starts immediately below it.)

**And the inverse gate, which is the useful half: the system masks its own money, so look for that
before concluding a module has no filmable portal screen.** On `/employee-portals/payslips`,
`PayrollStat` holds `isValueVisible = useState(false)` and the breakdown holds
`isBreakdownVisible = useState(false)`, so Gross, Net, Basic, Base and every breakdown row render
`******` until the viewer clicks an eye — one toggle per card
(`src/components/employee-portal/dashboard/payroll-payslips-section.tsx:81, 175, 339`). The
untouched default state is filmable with nothing staged. 🔴 **But `PayrollSummaryPanel`, in THE SAME
FILE, prints net salary at `text-3xl` with no mask and no toggle (`:137`)** — so "that file renders
money" answers nothing about either component, and a per-file money count is the wrong unit. Check
the component that the route actually renders.

🔴 **Gate 4 — THE STAGING MASK RENAMES PEOPLE AND NOTHING ELSE, SO HUMAN REMARKS GO OUT
UNMASKED** (added 6 Oct 2026, building video 06 — outstation expenses).
`EligibilityResultCard` prints `result.approvalReason` as a paragraph. The column's TYPE is clean
— no currency, no formatter — but on STORED rows staging's content reads *"No expense from Tanta
To Mahalla Dr Rasha appreciate ur efforts"* (a real manager's own words, naming a real doctor) and
*"Cancelled 2026-08-09 by the owner as a DUPLICATE of request #64 — the same Tanta trip on
2026-08-09, filed two minutes later (10:30 vs 10:28)"* (narrates a cancellation, names a request by
number). **So the card is filmable only in the WIZARD, where the engine composes the reason in front
of you — never on a stored row and never in the admin queue.** The same component is safe or unsafe
depending on which row feeds it. `eligibility_reason`, by contrast, is always engine-written and is
the module's best sentence: *"Distance 58.39 KM is below official minimum (60 KM) but within
tolerance (58 KM). This is accepted with warning."*

**And a fourth kind of gate that is not about content at all: a panel can render its verdict in the
WRONG COLOUR.** `territory-validation-panel.tsx` styles `outside_expected_territory` emerald and
`matched` amber — inverted — so on camera a green badge says the opposite of what it means. Read the
tone map, not just the text.

**How to apply:** before promising a screen, open the page file and the service behind it. Ask
(a) does this view, or anything it opens, render money? and (b) is the person I am filming inside
the view's own scope — not just the nav's? A route existing and a nav row pointing at it prove
neither. `/employee-portals/profile` was the right screen all along: hire date, reporting manager,
line, department, probation status, and the system's own sentence *"Your profile is read-only. HR
can update your contract, area, manager, or contact details."*
(`app/employee-portals/profile/page.tsx:148, 184-188, 325`).
