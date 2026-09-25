---
name: the-system-never-auto-approves-a-plan
description: "Owner rule 2026-09-05: the system NEVER auto-approves a weekly plan. A District Manager's chain is submit -> NSM (or RSM if applicable) -> HR acknowledge, with NO CEO stage at all — not a human one, and not a system-signed one."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9bd5faf7-cdd1-4b85-a42c-abcc1dcbffa0
  modified: 2026-09-06T09:45:27.118Z
---

Owner, 2026-09-05, asked directly and answered twice: **"the system never auto approve a plan"**,
then **"in district managers plan remove the step of ceo approval make it nsm or rsm if applicable
then the hr ack"**.

So a District Manager's weekly plan chain is exactly three steps:
**submit -> NSM (or RSM if applicable) approves -> HR acknowledges.** No CEO stage exists on it.

**Why this needs its own memory.** He was offered a system actor for the auto-approval step
(matching the existing `SYSTEM-AUTO-HR-ACK` on the acknowledgement) and **rejected the premise** —
the objection is not to the LABEL on the approval, it is to the approval EXISTING. Acknowledgement
signed by the system is fine; approval signed by the system is not. A session reading only "drop the
CEO" will re-add a cascade and think it is complying.

**What was wrong.** After a manager approved a DM plan, the code issued a SECOND `ceo_approve`
decision ~0.1s later under **that same manager's own identity and role**, as the mechanism for
"cascade to final_approved". The approval history therefore showed three National Sales Managers
appearing to have approved plans as the CEO. Measured on production: 42 such rows, 42 plans,
2026-08-14 to 2026-09-05, all sub-second and same-actor — the machine fingerprint.

**Applied to PRODUCTION 2026-09-05 — do NOT undo.** The 42 fabricated rows were deleted from
`public.employee_plan_decisions`; pre-image kept in
`plan_audit_backup_20260905.dm_fabricated_ceo_approve`. Verified after: 494 -> 452 decision rows,
NSM-authored `ceo_approve` on DM plans 0, `manager_approve` on DM plans unchanged at 50, DM plans
final/acknowledged unchanged at 50.

**A DM plan now carries NO `ceo_approve` row at all — owner 2026-09-06: "remove the 8 too".**
All 50 are gone: the 42 machine rows on 09-05, then the remaining 8 GENUINE human decisions
(7 by Super Admin Omar Gawish, 1 by CEO Anwar Gaweesh, both 2026-08-07/08) on 09-06, once he
confirmed the rule reaches history and not just new plans. Pre-image for the second batch is
`plan_audit_backup_20260905.dm_human_ceo_approve` (8 rows). Verified after: `ceo_approve` on DM
plans **0**, DM plans left with NO approval **0**, `manager_approve` unchanged at 50, DM plans
final/acknowledged unchanged at 50, and `ceo_approve` on NON-DM plans untouched at **55** — the CEO
stage still works for every other role. **Do NOT undo, and do NOT read a DM plan's missing CEO row
as data loss.**

**They were never one population, and that still governs any future sweep.** 42 were machine
(sub-second gap, same actor as the manager approval); 7 were Super Admin decisions made 7-18 HOURS
later by someone who had NOT given the manager approval; 1 was the CEO. They were removed in TWO
passes for that reason — the machine rows on evidence, the human rows only on the owner's explicit
say-so. **Never delete a human decision on the same predicate that catches a fabricated one.**

**Deleting the decision row does NOT clean the header — and the SCREENS read the header.**
`employee_plan_headers` carries a denormalised `ceo_decision_at` / `ceo_decision_by_hr_id` copy of
what was written to `employee_plan_decisions`, so both passes above left 8 DM headers still stamped
while their decision rows were gone: the audit trail said the approval never happened and two
decision-history screens still attributed it to the CEO / Super Admin, dated 8 August.
`getAllPlanDecisionsCompanyWide` mis-labelled them, and the Action Center used the stamp as its
**fetch filter**, so the rows reached Omar Gawish's own history *because of* the residue. The
per-plan TIMELINE was already correct (`buildPlanTrackerSteps` drops the CEO step for DM plans),
which is exactly why it survived — **checking the plan tracker does not detect this.** Cleared in
production 2026-09-06 (pre-image `plan_audit_backup_20260905.dm_header_ceo_residue`, 8 rows, full
row); `final_approved_at` was deliberately KEPT on all 8 — it is the real
`manager_approved -> final_approved` transition time, not residue. Guarded in code by
`resolvePlanCeoDecision` (`src/lib/weekly-planning/plan-v1.ts`) plus
`tests/dm-plan-has-no-ceo-stage.test.ts` in the required CI `validate` job, so no read path can
show a CEO decision on a plan kind that has no CEO stage whatever the header holds.

⚠ **The non-DM `ceo_approve` count MOVES — never re-verify against a fixed number.** It reads 55
in the 09-05 paragraph above and was **56** on 09-06, because the CEO stage is live for every other
role and one more plan was approved in between. That is the stage working, not a regression. What
is durable is the SHAPE: DM `ceo_approve` rows 0, DM plans with no approval left 0, DM
`manager_approve` 50, non-DM untouched.

**How to apply.** Never implement a "skip a stage" rule by writing a decision row for the skipped
stage. Let the state transition carry it. And when auditing an approval trail here, classify by the
GAP and the ACTOR before acting: a sub-second decision by the same person who just decided the
previous step is machine output, never a human click. When you delete a decision row, **check for a
denormalised copy of it on the parent header** — the audit table and the screens are two different
sources, and only one of them is what the owner looks at.

Related: [[dm-approval-chain-drops-the-ceo-never-the-nsm]] is the VACATION chain and a different
module — both hold at once. See also [[a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace]]
for the same shape of defect: a silent automatic step that leaves a misleading record.
