---
name: rec-032-owner-decisions-same-notices-and-expense-batch
description: "REC-032 one approvals interface — owner chose \"same notices only\" (no new notices) and Expense Approvals keeps its batch save but wears the shared row (14 Nov 2026)"
metadata:
  node_type: memory
  type: project
  originSessionId: d6cd0e8b-e41c-4195-bfe9-3759a7718c37
  modified: 2026-11-14T01:03:13.365Z
---

Owner decisions for audit item REC-032 (one approvals interface, notices + screens in ONE PR), 14 Nov 2026 ~03:05 Cairo, by multiple choice:

1. **"Same notices only"** — every module's approval notices move onto the one raising function, but each person receives exactly what they receive today. The known gaps are NOT filled in REC-032: expense claims send no "waiting for you" to the approver and no "approved"; probation and deduction decisions are silent; Market Awareness approval reaches the requester and his manager only as an email Cc. They go on a list for him to decide one by one.
2. **Expense Approvals "Keep its batch save"** — it wears the shared approval row's look and wording, but claims are still marked on screen and saved together (POST /api/admin/outstation/expenses).

Standing scope (from the plan): Marketing keeps its own inbox; who approves does not change.

**Why:** a new notice is a new outbound message to real people; he decides those individually.
**How to apply:** a REC-032 change that adds a recipient, a channel or a new notice step is out of scope — list it, do not wire it. Related: [[s05-owner-decisions-safety-owner-and-field-probation]].
