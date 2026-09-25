---
name: double-visit-gpm-line-id-scope
description: "Double-visit GPM/PM scope must widen by line_id (sameWorkforceLine), NOT by line_name text — DV import line labels use a different code scheme than the canonical lines table."
metadata: 
  node_type: memory
  type: project
  originSessionId: 042dd0d3-dd9e-4671-8df3-ecbc78c4972a
---

SHIPPED to prod 2026-06-21 — PR #416 (squash `8ed20796`), CI green, Vercel prod deploy success, `phoenix-workforce.vercel.app` healthy. `resolveDoubleVisitAccessScope`
in `src/lib/double-visit-analytics/service.ts` widened GPM/PM to their product line by matching
the **DV row `line_name`** against the manager's resolved line name. That is broken in production:

- The canonical `lines` table (prod `ozucdzovmcqvepbozvqf`) is: 1=`Anti infective`, 2=`Pedia`, 3=`CNS`, 4=`Head Office`.
- The published Double-Visit import (`DSM DV.xlsx`) labels rows with a DIFFERENT free-text code scheme:
  `C` (1449 visits), `E` (1311), `F` (1233), `P` (578), `A` (264), `Pedia` (94), null (70), `Anti Inf` (19).
  These rarely match `lines.name` — e.g. line 1 resolves to "Anti infective" but the DV label is "Anti Inf" → **zero** match.
- Raw `employees.line_name` is NULL for all active employees; the directory resolves `lineName` from `lines(name)` via `line_id`. So lines are reliably keyed by **`line_id`**, never by text. See [[employees-line-name-not-line]].

Effect before fix (chain + line-name match): GPM A-8 (Pedia) saw 124 of 1,892 line visits (6.5%);
PM A-10 (Anti infective) saw 73 of 1,641 (line-name added 0 because of the label mismatch).

**Fix:** widen via `sameWorkforceLine(viewer, employee)` (line_id-preferred, name fallback) and add every
same-line member to `allowedHrIds`, so a DV is in scope when the double-visitor OR visited MR is on the
GPM/PM's `line_id`. The test (`tests/double-visit-analytics.test.ts`) was rewritten to use `line_id` fixtures
(same-line peer IS in `allowedHrIds`; a different `line_id` is excluded) — this supersedes the earlier
`allowedLines.size`/line-name assertions that flip-flopped across #386/#404. **Rule:** for any line-scoping,
match on `line_id` via `sameWorkforceLine`, never on `line_name` text.

Same audit also fixed the read-only GPM portal page (`/employee-portals/double-visit-analytics`): hid the
admin Imports tab, fixed the Refresh button that ejected portal users to `/admin/*`, de-duplicated the header,
added a working date filter (`embedded` prop on `DoubleVisitAnalyticsWorkspace`). Related: [[pm-gpm-vacancy-line-scope]], [[portal-sidebar-real-source]].
