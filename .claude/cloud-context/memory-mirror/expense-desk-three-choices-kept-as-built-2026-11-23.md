---
name: expense-desk-three-choices-kept-as-built-2026-11-23
description: "Owner's three multiple-choice answers on the rebuilt Expense Approvals desk (PR 699), 23 Nov 2026 — refuse a reduction on a payroll-held trip, full-screen Open instead of expand-in-place, decided trips read-only after Undo"
metadata:
  node_type: memory
  type: project
  originSessionId: fec79187-477a-4fee-951b-cd4da7bc020f
  modified: 2026-11-23T19:21:27.288Z
---

On 23 Nov 2026, about 07:40 Cairo, the owner answered three multiple-choice questions about the rebuilt
Expense Approvals desk (pull request 699, `src/lib/outstation/approvals/`, the `approvals-desk/` screen).
He picked the as-built option each time:

1. **A reduced amount on a trip payroll would hold is REFUSED, in words** — "Keep refusing". Such a trip
   has no payroll row yet, so a reduced figure cannot be kept; the old screen approved it, lost his figure
   and paid in full on release. No carry-over on the release path was asked for.
2. **A trip opens FULL-SCREEN from its row** — "Keep full-screen Open". This supersedes the in-place
   expand of his 9 Nov 2026 rule ("MAKE THIS COLLAPSABLE AND EXPANDABLE"); the row's Open and the
   one-by-one reviewer are one way to read a trip.
3. **A decided trip is READ-ONLY once the six-second Undo has passed** — "Keep read-only". No decided
   claim's money moves from this page.

**Why:** these were the three places the rebuild departs from an earlier behaviour or rule of his; he
confirmed each rather than have it changed back.

**How to apply:** do not "fix" any of the three back (no expand-in-place under a row, no reduction
accepted on a held trip, no edit of a decided trip from the desk) unless he asks in his own words. A
carry-over or a guarded change of a decided claim touches the payroll path: design it and show him first.

**Choice 3 was LIFTED the same day, about 21:05 Cairo**, in his own words: "make me able to reject even
if approved in history. Make me easily able to approve or reject." Since then a decided claim takes ONE
press on its History row and in its opened trip: an approved claim no payroll has taken → Reject (with a
reason); a rejected claim → Approve in full. Still closed: approving an approved claim again, keeping it
full or reducing it (the press that lost his typed figure), and any change to a claim in payroll or whose
payout month's payroll already ran. The rule lives in `.claude/rules/expenses.md` ("A DECIDED CLAIM IS
CHANGED ON ITS HISTORY ROW"). Choices 1 and 2 still stand.
Related: [[the-next-step-box-must-not-manufacture-the-next-task]], [[fix-means-fix-no-unrequested-work]].
