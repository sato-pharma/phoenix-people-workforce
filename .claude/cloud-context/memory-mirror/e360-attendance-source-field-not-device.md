---
name: e360-attendance-source-field-not-device
description: "Field reps have NO device attendance — use FIELD_WORKFORCE no_activity deductions as the attendance-equivalent"
metadata: 
  node_type: memory
  type: reference
  originSessionId: f2052a5b-d2b4-46ea-9c8a-82be1c8eb6a0
---

For any "attendance" signal on **field-force** people (medical reps and their managers), do NOT use the fingerprint/device pipeline — it will read a misleading zero.

Verified in prod (2026-07-18):
- `attendance_raw_punches` has data for only **~17 distinct employees** (office/HO pilot ZKTeco devices); field medical reps do not punch. Range Jan–Jul 2026.
- `deduction_candidates` with `source_module = 'ATTENDANCE_DEVICE'` = **0 rows** in prod. Device attendance never flowed into the deduction pipeline.
- The populated, meaningful field-force attendance-equivalent is `deduction_candidates` `source_module='FIELD_WORKFORCE'`, `deduction_type='no_activity'` (a confirmed day of zero field activity — the field-force "absence"). ~84 live rows, 68 distinct reps, months 2026-05..06, `dates` jsonb = array of affected days. Compact key = `compactDeductionHrId(hrId)` = `canonicalHrIdKey` then strip non-alnum.

So: field-rep "attendance/absence" = FIELD_WORKFORCE no_activity deductions, NOT device punches. This is the same truth as [[probation-module-is-field-force-only]] and the "managers never check in" model — field presence is measured by visits/activity, not clock-in devices.

Weekly plans: only a handful of **managers** (NSM/TM/GPM/PM) hold `employee_plan_headers` rows today; medical reps have ~none — so rep weekly-plan compliance truthfully reads ~0% (a real adoption gap, not a bug). Used by `src/lib/employee-360/team-lifecycle.ts` (PR #1163). See [[employee-360-godmode]].
