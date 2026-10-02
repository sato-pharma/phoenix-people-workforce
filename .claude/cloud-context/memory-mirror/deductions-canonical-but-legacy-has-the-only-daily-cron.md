---
name: deductions-canonical-but-legacy-has-the-only-daily-cron
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: RESOLVED 2026-08-30 — legacy governance CODE removed and its 7 DB tables ARCHIVED off public ... Only the unified src/lib/deductions module is live (see `two-live-deduction-engines-p0`). Older text follows: deductions_* is the owner-ruled source of truth, but legacy deduction_* still backs a LIVE attendance day-report decision workflow — freezing it blind breaks that feature; a daily canonical cron is impossible by design"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75a0c0fe-3f17-469a-aca9-812ef437e71b
  modified: 2026-10-01T00:00:00.000Z
---

Owner ruled 2026-08-13: **`src/lib/deductions/` (`deductions_*`) is the deductions source of truth**
(payroll reads it via `automated-payroll/deductions-source.ts`). Coverage is complete — its
connectors supersede every legacy `deduction_*` connector, and `deductions/connectors/crm.ts`
*corrects* three leaver bugs (B-111) that legacy `deductions-governance/connectors/field-workforce-compliance.ts` still has.

**Do NOT build a daily canonical cron, and do NOT freeze legacy as a one-liner.** Both were
attempted 2026-08-13 and are wrong:

- **A daily canonical cron is impossible by design.** `collectAllCandidatesForMonth` is documented
  "NOT safe from an HTTP handler" (#1377 Cloud-Run revert), `isCollectableMonth` HARD-REFUSES the
  current month (owner rule 2026-08-03: collecting an in-progress month charges people for unfinished
  days and CRM publishes with no approval step), and canonical writes are Super-Admin-gated.
  Canonical is **end-of-month, operator-driven by design** — there is no daily gap to fill.
- **THE REAL FREEZE BLOCKER:** legacy `deduction_*` is NOT a retired shadow. It is the live backing
  store for `upsertAndDecideEmployeeDayDeduction` (`attendance/employee-day-report.ts`, via
  `POST /api/attendance/employee-day-report/decisions`) — the attendance day-report per-day
  deduction decision feature, legacy-only. **Freezing legacy writes breaks this live feature.**
- The legacy daily `runFieldWorkforceComplianceDeductionsAutoSync` (`notifications/daily/route.ts`
  ~line 142) writes legacy candidates that payroll no longer reads (payroll reads canonical). Its
  "creates money records" comment predates the 2026-08-03 canonical bridge and is stale re: payroll.

**Safe cutover order:** MIGRATE the attendance day-report decision workflow onto canonical FIRST
(scoped feature migration, owner sign-off — it changes how per-day deductions are recorded) → then
freeze legacy behind a compile-time flag (mirror `DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED`, keep
read paths open). The automated monthly scan needs nothing — canonical already supersedes it.

**B-2 is cosmetic, not a hole:** the sync routes gate on `assertPermission(…,"read")` THEN
`assertDeductionsGovernanceDecisionActor` = Super-Admin-only; every `deductions` role has
`allActions`. No read→create fix needed. Full analysis:
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
those are the only copy and must not be dropped casually. The part that is now false is the urgency:
nothing live reads legacy, so this is a retirement to plan, not a hazard to route around.
Full write evidence in [[two-live-deduction-engines-p0]].
