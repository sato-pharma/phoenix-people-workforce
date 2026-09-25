---
name: employees-work-email-is-unique-indexed
description: "employees.work_email carries a UNIQUE index, so two people can never share an address — pointing a system account at a real person's mailbox fails"
metadata: 
  node_type: memory
  type: reference
  originSessionId: d0007173-7b15-4def-a4c3-f0d0670c67f0
  modified: 2026-08-08T09:36:45.865Z
---

`employees_work_email_key` is a **UNIQUE btree index on `employees.work_email`** (verified in
production 2026-08-08).

Two rows can never hold the same address. This blocked pointing the `PHX-1` system-admin account at
`omar.anwar@satopharma.com` (already B-10's) — the update would have failed with a constraint
violation. `PHX-1` was set to `phoenix@satopharma.com` instead, which was free.

**Why:** the obvious fix for "this account has no mailbox, send its mail to me" is to copy a real
person's address in, and that always fails here.
**How to apply:** before assigning a `work_email`, check the address is not already taken. For
system/shell accounts (`PHX-1`, `ADMIN-HR`) use a dedicated shared mailbox, not a person's.
Relevant because a missing `work_email` now blocks the send outright — see
[[general-email-policy-routes-to-hr-inbox]].
