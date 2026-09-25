---
name: report-it-sounds-like-hr-and-is-patient-data
description: "\"Report It\" is the pharmacovigilance ADR register, not a staff grievance channel — and report_it:export is the read-EVERY-patient-report gate, held by three roles only"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10c9e0cd-506e-4881-977d-63fca5e0190c
  modified: 2026-08-28T06:06:54.671Z
---

**The module named "Report It" is pharmacovigilance** — adverse drug reactions. Its rows carry
patient reactions, seriousness (`Life threatening`, `Death`, `Caused/prolonged hospitalisation`,
`Congenital anomaly/birth defect`), `suspected_medicines`, administration route and outcome. See
[[report-it-module-build]] for the full build.

**The name is the trap.** "Report It" reads like a staff complaints or whistleblowing channel, so
any job description mentioning *employee concerns*, *grievances* or *reporting process gaps* looks
like it maps here. It does not. The HR route for those is `support_requests`.

**`report_it:export` is not "download a spreadsheet" — it is the read-EVERY-report gate.**
`canViewAllReports` (`src/lib/report-it/service.ts:8`) returns true on that one action, and
`listReports`/`getReport` then drop the `submitted_by_hr_id` filter. Without it a caller sees only
their own submissions. It is held by **Super Admin, CEO, Finance Manager** and nothing else.

**Caught live 2026-08-28.** Composing the two new HR seats from a function catalogue
([[hr-seats-are-composed-from-a-function-catalogue]]), two of the eight functions granted
`report_it: ["read", "create", "export"]` because the HRBP job description asks for employee
engagement and concerns. That would have handed both HR seats every adverse-event report in the
company. `tests/report-it-access.test.ts` caught it — it had pinned that privacy boundary long
before either seat existed, listing every self-only role by name.

**How to give a person access without a role grant.** There is a designed per-person route:
the `report_it_dashboard_access` table, checked by `canViewAllReports` as a second path. Add the
`hr_id` there. Never widen a role to solve a one-person need.

**Why the boundary list did not stop it, and what changed.** `HR_ROLE_BOUNDARIES` in
`src/lib/auth/hr-functions.ts` was built from what the job descriptions FORBID, and neither JD
mentions patient data at all — so the list was silent on exactly the grant that mattered. A
boundary list derived only from a document's prohibitions misses everything the document never
thought to name. `report_it:export` is now pinned there explicitly.
