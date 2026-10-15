---
name: the-plan-auto-assigns-the-rep-from-the-employee-area-not-the-seat
description: "The weekly/monthly plan has NO rep dropdown — the rep is auto-assigned from the picked AREA, and the area comes from the EMPLOYEE record with the seat filling only a blank, so a wrong area_id hides a rep with no warning at all"
metadata:
  node_type: memory
  type: project
  originSessionId: 375897be-8464-4c0c-8649-7861f2eb3dcd
  modified: 2026-10-15T14:02:11.520Z
---

A manager reporting "X is not appearing in my plan droplist" is almost never a dropdown: the
weekly/monthly plan (`src/components/employee-portal/plans-workspace.tsx`) has **no rep picker**.
He picks Region → Area, and `autoRepForArea` → `eligibleRepsForArea` resolves the rep by matching
the area **NAME**. The rep list itself is `medicalRepOptionsForEmployee`
(`src/lib/weekly-planning/service.ts`), whose area is
`candidate.areaName?.trim() || seats?.areaByHrId.get(...)` — **the employee record wins and the AU
seat only fills a BLANK.**

So a rep whose `employees.area_id` names another rep's area is invisible two ways at once, and
**neither says anything**:

- her own area shows no rep, and the amber "needs an assigned Medical Rep" cannot fire, because
  `areaHasAssignableRep(<her area>)` is false — the warning only exists for an area that HAS a rep;
- the shared area auto-assigns `eligibleRepsForArea(...)[0]`, which is sorted by full name, so the
  alphabetically earlier rep wins and the other appears nowhere.

Shahd Mohamed Elsayed Ghoneim (PD-0026) was hired into `SEAT-PED-REP-AB4` / Behira 1 on 8 Oct 2026
and her employee row was edited to Behira 2 — Mostafa Saied's (B-177) area — on 13 Oct. Mohamed
Eleiwa (PD-0012) reported her missing on 15 Oct. Fixed by setting `area_id` 1093 → 1092 on
production; no code change was needed.

🔴 **`public.au_v_employee_seat_drift` would have caught it the day it happened and nothing alarms
on it** — its `area_id_drifted` compares exactly these two columns. Its four readers
(`planning-areas.ts`, the two CRM coverage loaders, `employee-360/brick-coverage.ts`) only use it
for lookups; there is no Needs You source and no reconciliation check. Query it first whenever a
person is missing from an area-keyed screen. See [[au-seat-drift-view-is-the-org-truth-check]] and
[[directory-active-filter-gate]].
