---
name: attendance-weekly-digest-selfsettlement-spec
description: "The weekly attendance digest + self-settlement was torn down 2026-07-22 (#1253) and REBUILT 2026-09-08 (#3495) at the owner's request — it is LIVE in src/lib/attendance/ (digest-service, digest-bridge, …). Releasing a flagged week starts a real deduction path; employees wait at awaiting_release and the owner releases them himself — never suggest it. The month-end Fingerprint connector stays the ONLY writer of deduction candidates. Holds the durable owner rulings and the code relics that survived the teardown."
metadata: 
  node_type: memory
  type: project
  originSessionId: 370ebea6-f132-465a-8b17-65de47800a24
  modified: 2026-10-02T16:35:30.311Z
---

🔴 **The weekly attendance digest / self-settlement feature IS LIVE — rebuilt on 2026-09-08 (PR #3495,
`5866e0a84`) at the owner's request**, once the accuracy gate it originally failed read 0.00% across five
closed months. It lives in `src/lib/attendance/` (`digest-service.ts`, `digest-bridge.ts`, `digest-generator.ts`,
`digest-notify.ts`, `digest-weeks.ts`, `digest-rules.ts`, `digest-reconcile.ts`), with the portal page
`/employee-portals/attendance/digests`, the cron `app/api/cron/attendance-weekly-digest`, and migration
`20260908154500_weekly_attendance_digest_rebuild.sql`. Three things are deliberately NOT the 2026-07 shape:
**one writer of money** (the month-end Fingerprint connector stays the only author of deduction candidates;
`digest-bridge.ts` applies the employee's ANSWER to the candidate once the connector has created it — two
writers of one employee-day is how 19 employee-days were charged twice in July 2026); **`dry_run` defaults
true** and is frozen onto each digest at generation (the bridge refuses a dry-run settlement); and the cancel
rule is inherited from the report, not copied. Channels: in-app, Telegram and email (owner, 2026-09-08), each
a setting. 🔴 **Releasing a flagged week starts a real deduction path — flagged employees sit at
`awaiting_release` and the owner releases them himself; never suggest releasing, and never offer to switch
`dry_run` off in chat** ([[never-suggest-releasing-attendance-weeks-owner-releases-himself]]).
**Superseded 2026-10-02:** previously "FULLY TORN DOWN on 2026-07-22 (#1253), gone from code and both
databases, must be rebuilt from git history, never un-paused" — the owner had it rebuilt in #3495 on
2026-09-08. The 2026-07-22 teardown (portal page, 6 admin pages, ~22 routes, 15 service files, the
`attendance_digest` template, the cron step and 6 tables via `20260722103000_drop_attendance_digest_feature.sql`)
remains history; PR #758 built the first version.

**The durable owner ruling (set for the 2026-07 module; the 48h auto-confirm and the hold-before-release step carry into the 2026-09-08 rebuild):** the model was employee-driven, not silently punitive —
each in-scope head-office employee got weekly digests over the 24→24 payroll cycle with a Confirm/Dispute
choice, 48h silence auto-confirms, HR reviews only disputes. 🔴 **Settlement is SALARY-ONLY — the CEO/COO
rejected the leave-balance option** (no balance/leave-deduction logic). And after a live incident, no
deduction-bearing digest may ever reach an employee directly — it must route to System Admin/HR for review
first. Deductions flowed through the existing audited deductions-governance → day-24 payroll import (÷30 lived
in the attendance engine, never in the locked `policy.ts`). In the rebuild, deductions materialise only after
month-end via the Fingerprint connector + `digest-bridge.ts`.

## Code relics that SURVIVED the 2026-07-22 teardown (a future session will hit these)

- **`src/lib/payroll/copilot/cycle-window.ts`** — the shared 24→24 payroll cycle-window math was split OUT of
  the deleted `digest-cycle.ts` because Payroll Copilot depends on it independently of digests.
- **`ceoHrIds()` now lives in `src/lib/employees/role-lookup.ts`** — relocated out of the deleted
  `digest-recipients.ts` because Direct Orders uses it (unrelated to digests).
- **`employee-day-report` was KEPT** as a general read-only browse report (its digest-linked Confirm/Decline
  concept dropped), re-gated to **Super Admin only** — NOT "HR Manager", which is a job title, not an app role
  ([[job-title-not-a-permission-source]]).
- **Harmless DB residue:** `attendance_policy_groups` rows still carry cosmetic "— Weekly Digest Policy" names
  (data, not code — out of scope, leave them).
