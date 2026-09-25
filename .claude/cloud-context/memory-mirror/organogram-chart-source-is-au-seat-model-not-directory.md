---
name: organogram-chart-source-is-au-seat-model-not-directory
description: "The organogram CHART and the employee DETAIL popup read from two different sources; to add a per-person field to the chart you must edit the seat report's select, not the directory."
metadata: 
  node_type: memory
  type: project
  originSessionId: dcbc7c4b-909c-4736-8b58-513b29d09052
  modified: 2026-08-15T21:39:21.763Z
---

The company organogram renders from **two different data sources**, and they disagree
unless kept in sync:

- **The CHART** (`getOrganogramReport` → `buildOrganogramSeatReport` in
  `src/lib/reports/organogram-au-source.ts`) is built from the **AU seat model**
  (`au_v_org_tree`). It only carries the employee fields it *explicitly* selects from
  `employees`. For a long time it selected only `hr_id, full_name` and **hardcoded
  `hireDate: null`** — so any per-person field beyond the name was blank on every node.
- **The DETAIL popup** (the `/api/reports/organogram/employee/[hrId]` route) reads
  `getEmployeeDirectory()`, which selects the full master (hire_date, salary, etc.).

So the detail popup could show a correct hire date while the chart showed nothing — same
person, two sources. **To add a new per-person field to the chart, add it to the seat
report's `employees` select and its row mapping — editing the directory does nothing for
the chart.**

Live prod 2026-08-16 (#2164, squash `25fbfcc0`, do NOT undo): joined `hire_date` into
the seat report (0/94 → 94/94 nodes), added name + hire date + area on every node, and a
clickable node → role-gated employee popup. Sensitive sections (Personal + Compensation:
salary/national ID/bank) are decided server-side by `canViewOrganogramSensitiveFields`
(system / Super Admin / CEO / Finance Manager / Talent Acquisition only) in the API route,
never in the browser; line managers get a 404 for anyone off their own chart. A line
manager above area level has a null area by design — the node falls back to region.

Deeper structural audit of the organogram lane engine was deferred to a separate follow-up
session per the owner's instruction. Related: [[au-seat-drift-view-is-the-org-truth-check]].
