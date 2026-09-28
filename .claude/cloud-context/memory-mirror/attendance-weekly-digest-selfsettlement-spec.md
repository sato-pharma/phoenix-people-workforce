---
name: attendance-weekly-digest-selfsettlement-spec
description: "The weekly attendance digest + self-settlement feature was REMOVED ENTIRELY 2026-07-22 (PR #1253) — gone from code AND both databases (6 tables dropped). Do NOT recommend re-enabling dry_run/required_minutes or any digest/settlement UI; if attendance deductions are ever wanted again they must be rebuilt from git history, not un-paused. Kept only for the code relics that SURVIVED the teardown and the one durable owner ruling."
metadata: 
  node_type: memory
  type: project
  originSessionId: 370ebea6-f132-465a-8b17-65de47800a24
  modified: 2026-09-26T05:44:05.754Z
---

🔴 **The weekly attendance digest / self-settlement feature was FULLY TORN DOWN on 2026-07-22 (PR #1253) —
not paused, removed.** Deleted: the portal digest page, 6 admin pages (Digest Review, Disputes, Missing-Punch
Verification, Settlement Dashboard, Passport, HR Pattern Insights), ~22 API routes, 15 service files, the
`attendance_digest` email template, the cron step, and the 6 digest tables (migration
`20260722103000_drop_attendance_digest_feature.sql`, applied to staging AND production). **It is gone from
code and from both databases.** Do NOT recommend re-enabling `dry_run` / `required_minutes` or any
digest-review/settlement UI — if the owner ever wants attendance deductions back it must be **rebuilt from git
history (PR #758 built it, #1253 removed it), never "un-paused."**

**The one durable owner ruling, if it is ever rebuilt:** the model was employee-driven, not silently punitive —
each in-scope head-office employee got weekly digests over the 24→24 payroll cycle with a Confirm/Dispute
choice, 48h silence auto-confirms, HR reviews only disputes. 🔴 **Settlement is SALARY-ONLY — the CEO/COO
rejected the leave-balance option** (no balance/leave-deduction logic). And after a live incident, no
deduction-bearing digest may ever reach an employee directly — it must route to System Admin/HR for review
first. Deductions flowed through the existing audited deductions-governance → day-24 payroll import (÷30 lived
in the attendance engine, never in the locked `policy.ts`).

## Code relics that SURVIVED the teardown (a future session will hit these)

- **`src/lib/payroll/copilot/cycle-window.ts`** — the shared 24→24 payroll cycle-window math was split OUT of
  the deleted `digest-cycle.ts` because Payroll Copilot depends on it independently of digests.
- **`ceoHrIds()` now lives in `src/lib/employees/role-lookup.ts`** — relocated out of the deleted
  `digest-recipients.ts` because Direct Orders uses it (unrelated to digests).
- **`employee-day-report` was KEPT** as a general read-only browse report (its digest-linked Confirm/Decline
  concept dropped), re-gated to **Super Admin only** — NOT "HR Manager", which is a job title, not an app role
  ([[job-title-not-a-permission-source]]).
- **Harmless DB residue:** `attendance_policy_groups` rows still carry cosmetic "— Weekly Digest Policy" names
  (data, not code — out of scope, leave them).
