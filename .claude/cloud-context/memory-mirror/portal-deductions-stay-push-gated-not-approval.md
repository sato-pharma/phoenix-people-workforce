---
name: portal-deductions-stay-push-gated-not-approval
description: "Owner chose 2026-10-07 to KEEP the employee portal Deductions page and its notice gated on the PUSH, not on approval. An approved-but-unpushed deduction being invisible on the portal is BY DESIGN, not a bug — the payslip shows every approved deduction that REACHED the payroll sheet at publish (one approved after its step was confirmed must be re-confirmed first; deduction-resync.ts re-opens the step when the decision moves, and describeDeductionResyncNotApplied warns when it cannot). Do NOT 'fix' the portal to show approved-unpushed, and do not re-raise it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 148528c7-4ca8-47cc-89bf-d72e4ed85da6
  modified: 2026-10-07T18:58:29.724Z
---

Asked directly on 2026-10-07 whether to change the employee portal so approved-but-unpushed
deductions appear there, the owner answered **"leave it as it is now."**

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
- **Employee portal → Deductions** (`/employee-portals/deductions` → `src/lib/deductions/portal.ts`,
  reads `deductions_publication_lines` where the publication is `published` and the line is
  `active`) — a row exists **only once the Super Admin PUSHES it**, which also fires the notice.

**Why:** the push is the owner's deliberate, controlled "notify the employee" moment; decoupling the
portal from it would show (and, in the stronger variant, email) employees deductions before he
chooses to. The payslip remains the authoritative "what you were charged" view.

**How to apply:** if a future task sees "an approved deduction is charged on the payslip but missing
from the employee's portal," that is the intended design, not a defect — do not wire the portal read
to approval. Only the owner reopens this.
