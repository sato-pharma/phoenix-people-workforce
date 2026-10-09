---
name: portal-deductions-stay-push-gated-not-approval
description: "SUPERSEDED BY THE OWNER ON 2026-10-09 — the portal Deductions page is now a LEDGER of every candidate from the September 2026 salary on, decided or not, and is NO LONGER push-gated (shipped #5608, live in revision 8e783cc54). Never restore the push gate or hide an approved-unpushed row. What survives: the NOTICE is still the push, and the payslip still shows only what reached the sheet at publish, so a deduction approved after its step was confirmed needs the step re-opened and re-confirmed (deduction-resync.ts does it; describeDeductionResyncNotApplied warns when it cannot)."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 148528c7-4ca8-47cc-89bf-d72e4ed85da6
  modified: 2026-10-09T01:12:53.987Z
---

🔴 **REVERSED BY THE OWNER TWO DAYS LATER.** On 2026-10-07, asked whether to change the employee
portal so approved-but-unpushed deductions appear there, he answered **"leave it as it is now."** On
**2026-10-09 he ruled the opposite** and the page was rebuilt as a ledger: `getPortalDeductionLedger`
starts from `deductions_candidates` (live, `month_key >= '2026-09'`), shows an **undecided** row
marked "Under review", derives the outcome from the **DECISION** (never the publication), and treats
the publication as one more fact — a released line is only what permits a reply. Shipped as #5608 and
live in production revision `8e783cc54`. **Do not restore the push gate, and do not read the
2026-10-07 answer below as current.** The rule now lives in `.claude/rules/payroll.md` ("THE EMPLOYEE
PORTAL'S DEDUCTIONS PAGE SHOWS EVERY DEDUCTION RAISED AGAINST HIM…") with its account in
`docs/deductions-employee-portal-ledger.md`.

**What did NOT change:** the **notice** to the employee is still fired by the push, and the payslip
still shows only what reached the payroll sheet at publish.

The 2026-10-07 sweep, kept because its three-surface map is still accurate apart from the third row:

**Three employee-side surfaces, three gates (confirmed by sweep 2026-10-07):**
- **Automated Payroll sheet** (admin) — reads the live Deductions module; shows an approved
  deduction *pushed or not* (see [[approved-is-not-pushed-and-a-confirmed-step-freezes-the-zero]]).
- **Payslip** (`/api/payroll/<batch>/payslips` → `salary_records`, the publish snapshot) — shows
  whatever reached the sheet at publish: every approved deduction whose payroll step carried its
  figure. A deduction approved **after** its step was confirmed stays frozen at the old figure
  until the step is re-opened and re-confirmed (`deduction-resync.ts` re-opens it automatically when
  the decision moves; `describeDeductionResyncNotApplied` surfaces a warning when it cannot) — so
  "every approved deduction" means every one that reached the sheet, not a late approval left
  unconfirmed. No portal change was needed here; the payslip already does this.
- **Employee portal → Deductions** — ⛔ **THIS ROW IS THE ONE HE REVERSED.** It read
  `deductions_publication_lines` (publication `published`, line `active`), so a row existed only once
  the Super Admin pushed it. Since 2026-10-09 it reads the live candidates instead; the push now
  fires the notice and permits a reply, nothing more.

**Why he reversed it:** the push gate meant an employee could be charged on the payslip while his own
portal showed nothing — 67 half-day rows for 26 people were in exactly that state. The notice stays
his controlled moment; the employee's own record of what was raised against him does not wait for it.

**How to apply:** the portal showing an approved-unpushed or still-undecided row is CORRECT. Never
re-gate the read on the push, never hide an undecided row "to spare the noise", and never derive the
outcome from the publication — an unknown decision status must fall back to "under review", never to
cleared. Proven on live data 2026-10-09: for one rep's six September rows the page renders 3
`on_payslip` (1,208.33 EGP, the same total the SQL aggregate gives), 3 `cleared` at 0.00, and offers
a reply on exactly the 3 released rows.
