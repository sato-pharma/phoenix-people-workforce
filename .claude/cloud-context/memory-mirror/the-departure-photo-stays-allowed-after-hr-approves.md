---
name: the-departure-photo-stays-allowed-after-hr-approves
description: "Owner ruling 2026-10-19 — after HR decides an outstation claim the employee can add nothing (extra tickets and journey stops are refused), EXCEPT the departure photo, which stays allowed because it is evidence that releases an approved car trip into payroll, not an addition to the money. Never block it under the \"nothing after HR decision\" rule."
metadata:
  node_type: memory
  type: feedback
  originSessionId: b5a82703-1ab9-426a-b8ed-1c3f4e217df3
  modified: 2026-10-18T22:26:37.591Z
---

After HR has decided an outstation claim the employee can add nothing to it. The one exception is the **departure photo**, which stays allowed after HR approves. The owner confirmed it in his own words on 2026-10-19: "keep the departure photo allowed after HR approves".

**Why:** the departure photo is evidence that RELEASES an already-approved car trip into payroll (the evidence gate, then `releaseOutstationRequestToPayrollIfReady`). It adds no money to the claim. Blocking it would leave approved car trips unpaid. An extra ticket and a journey stop DO change the figure, so those are refused once HR has decided (PR 6100; `undecided-claim.ts`, the one allow-list of open statuses).

**How to apply:** when asked to tighten what an employee can still do on a decided claim, treat extra tickets, journey stops and any other write that changes an amount as refused after the decision, and leave the departure photo capture, its retake inside the trip window and the location refusal alone. Do not add the photo to the allow-list's refusal. Related: [[outstation-expense-deep-audit-2026-07]], [[system-flags-expenses-never-rejects]].
