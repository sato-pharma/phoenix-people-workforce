---
name: outstation-submit-used-to-auto-approve-into-payroll
description: "Until 2026-08-08 an outstation submission approved ITSELF into payroll in the same second — the approvals queue only ever held claims an automated check had refused. Fixed in PR #1916; the release path's accepted-only guard is now the load-bearing back door."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8b476eaf-8391-427f-afd2-402222fcdb0b
  modified: 2026-08-08T20:04:19.834Z
---

Owner asked (2026-08-08) why the Expense Approvals screen wasn't showing everything submitted. It
was showing all of it — **21 of 29 live claims sat in the APPROVED tab having never been read by a
person**, and Pending held 2. Submitting an outstation expense approved it into payroll in the same
second: all three submit paths pushed straight through after the insert (employee submit via
`pushAcceptedOutstationExpenseToPayroll`; medical-rep + admin-manual via
`approveOutstationRequestForPayroll`, which flipped the row to `accepted_by_system` and wrote a
payroll row with `hr_approved = true`). Only claims an automated check REFUSED to clear
(`status = 'submitted'`) ever reached a human — so the evidence gate, workload gate and CRM claim
checks were decision-support for a decision already taken.

Fixed in PR #1916 (merged `29078a7d`): a clean submission persists as `submitted` and waits.
`calculation_status` still records `accepted_by_system` vs `submitted`, so "passed every automated
check" stays distinguishable from "held because a check could not run" — it just no longer decides
where money goes. The 21 existing claims (13,435.44 EGP, none yet in a payroll batch) were pulled
back to Pending and their payroll rows set `hr_approved = false`.

**Why:** two traps here bite anyone touching this flow again.

**How to apply:**
- **`releaseOutstationRequestToPayrollIfReady` is now the only back door.** It pushes to payroll when
  a departure photo arrives, and is safe *only* because it refuses anything whose status doesn't
  start with `accepted`. That guard was decorative before and is load-bearing now — relaxing it means
  an employee uploading his second photo pushes an unapproved claim into payroll. Pinned by
  `tests/outstation-submission-waits-for-approval.test.ts`.
- **The submission email fires from the submit paths, not from approval.** It used to ride inside
  `approveOutstationRequestForPayroll`; removing the auto-approval without moving the mail would have
  stopped every outstation submission email with nothing failing. Routing is To employee, Cc manager
  + skip-level, **Bcc active Super Admins** — that Bcc is what tells the approver the queue has
  something in it. Approving an ordinary claim is now silent; only a Super Admin overriding a system
  rejection still triggers the alert from the approve path.
- **`outstationStatusLabel` matches on SUBSTRINGS** (`"accept"`, `"approve"`, `"reject"`) — so
  `accepted_by_system` reads as "Approved" and sets `hrApproved: true` in the queue mapper,
  regardless of whether any payroll row exists. Don't invent a new status containing those
  substrings unless you mean it to display as decided.

Related: [[never-auto-publish-deductions-owner-confirms-first]]
