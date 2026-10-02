---
name: deductions-canonical-but-legacy-has-the-only-daily-cron
description: "deductions_* (src/lib/deductions) is the owner-ruled source of truth and the ONLY live engine — legacy deduction_* code was removed and its tables ARCHIVED off public on 2026-08-30, and the attendance day-report decision now writes deductions_candidates; a daily canonical cron is impossible by design"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75a0c0fe-3f17-469a-aca9-812ef437e71b
  modified: 2026-10-02T16:33:24.534Z
---

Owner ruled 2026-08-13: **`src/lib/deductions/` (`deductions_*`) is the deductions source of truth**
(payroll reads it via `automated-payroll/deductions-source.ts`). Coverage is complete — its
connectors supersede every legacy `deduction_*` connector, and `deductions/connectors/crm.ts`
*corrects* three leaver bugs (B-111) that legacy `deductions-governance/connectors/field-workforce-compliance.ts` had (that module is deleted since 2026-08-30).

**Do NOT build a daily canonical cron.** It was attempted 2026-08-13 and is wrong (so was freezing
legacy as a one-liner that day — moot now that legacy is archived, see below):

- **A daily canonical cron is impossible by design.** `collectAllCandidatesForMonth` is documented
  "NOT safe from an HTTP handler" (#1377 Cloud-Run revert), `isCollectableMonth` HARD-REFUSES the
  current month (owner rule 2026-08-03: collecting an in-progress month charges people for unfinished
  days and CRM publishes with no approval step), and canonical writes are Super-Admin-gated.
  Canonical is **end-of-month, operator-driven by design** — there is no daily gap to fill.
- **The attendance day-report decision writes CANONICAL now.** `upsertAndDecideEmployeeDayDeduction`
  (`attendance/employee-day-report.ts`, via `POST /api/attendance/employee-day-report/decisions`)
  writes `deductions_candidates` — repointed in the Track C cutover (owner-approved "Reconnect"), so a
  day-report confirmation charges in live Automated Payroll. Nothing live reads or writes legacy
  `deduction_*`, which was archived off `public` on 2026-08-30 — see [[two-live-deduction-engines-p0]].
  **Superseded 2026-10-02:** previously "legacy `deduction_*` is the live backing store for the
  day-report decision; freezing it breaks that feature" — the Track C cutover (C6 PR #2733, C7 PR
  #2746, 2026-08-30).
- The legacy daily `runFieldWorkforceComplianceDeductionsAutoSync` is GONE — it went with the
  `src/lib/deductions-governance/` module in C6; no caller remains under `src/` or `app/`.
  **Superseded 2026-10-02:** previously "the daily route still runs it, writing legacy candidates
  payroll no longer reads" — removed in C6 (PR #2733).

**Cutover order — DONE.** The planned order (migrate the day-report decision onto canonical first,
then freeze legacy) was carried out and went further: legacy code deleted (C6) and its 7 tables, 2
RPCs and trigger fn moved to schema `deductions_governance_backup_20260830` (C7). The automated
monthly scan never needed anything — canonical already superseded it.

**B-2 is cosmetic, not a hole:** the sync routes gate on `assertPermission(…,"read")` THEN
`assertDeductionsGovernanceDecisionActor` = Super-Admin-only; every `deductions` role has
`allActions`. No read→create fix needed — and moot since C6 (PR #2733) deleted those legacy sync
routes. Full analysis:
`artifacts/phoenix-rationalization-execution/B1_DEDUCTIONS_CUTOVER_SEQUENCING.md` §7.
Related: [[two-live-deduction-engines-p0]], [[never-auto-publish-deductions-owner-confirms-first]].

## 2026-08-23 — the "legacy backs a LIVE workflow" half is DEAD. Verified against production writes.

This file's caution was that freezing legacy `deduction_*` blind would break a live attendance
day-report decision workflow. That is no longer the risk it was:

- legacy `deduction_candidates` — last write **2026-08-02**; `deduction_decisions` — **2026-08-01**
- canonical `deductions_candidates` / `deductions_decisions` — both writing **2026-08-23**

Three weeks with no legacy write. A repo-wide search for `deduction_records` / `deduction_rules`
under `src/` and `app/` returns nothing at all.

**How to apply.** The remaining true part is the 324 historical rows the legacy family still holds —
those are the only copy and must not be dropped casually. They now live, preserved verbatim, in
schema `deductions_governance_backup_20260830` (archived 2026-08-30, reversible with
`ALTER … SET SCHEMA public`), so their absence from `public` is EXPECTED, not data loss. Nothing live
reads legacy. Full write evidence in [[two-live-deduction-engines-p0]].
**Superseded 2026-10-02:** previously "this is a retirement to plan" — the retirement shipped
2026-08-30 (C6 + C7).
