---
name: dsms-performance-hyphen-stripped-hrid-bug
description: "Root cause of empty DSMs Performance portal page — canonical (hyphen-stripped) HR IDs used directly in a Supabase IN-list query"
metadata: 
  node_type: memory
  type: project
  originSessionId: ba4bc4c4-86c9-49c8-a3dd-d627cb69b215
---

`/employee-portals/dsms-performance` (NSM "DSMs Performance" view, built by
`getNsmDsmPerformance` in [service.ts](../../../src/lib/employee-portal/service.ts))
showed all 6 DSMs by name/rank but EGP 0 sales/target everywhere and no period
filter pills — confirmed live 2026-07-04 via dev-auth as NSM A-12 (line 2) against
production data (local `.env.local` points at prod, see [[local-browser-verify-gotchas]]).

**Root cause:** the function builds `medRepToDsmCanonical` keyed by
`toCanonicalPortalHrId(emp.hrId)`, which strips hyphens (`"B-100"` → `"b100"`).
It then reuses `medRepToDsmCanonical.keys()` directly inside `salesQueryHrIds`,
the array passed to `fetchPortalSalesRecords(...)`, which builds a Postgres
`hr_id.in.(...)` list. Postgres does exact string matching, and
`v_employee_portal_sales.hr_id` stores the real hyphenated HR ID (`"B-100"`), so
`"B100"` never matches. Confirmed directly in prod SQL: `hr_id in ('B100')` → 0
rows, `hr_id in ('B-100')` → 64 rows. Since med reps are the only rows in that
view carrying `hr_id` (DSM's own `manager_hr_id` column is null for almost every
DSM — only 8 distinct managers across 7007 rows), stripping the hyphen zeroes out
the entire sales fetch for every DSM.

The sibling function ~350 lines below (`medRepHrIds = medRepRows.map(emp =>
emp.hrId)`, used by the working "MRs Performance" page) uses the RAW hrId for
the same query and is NOT affected — proof the DSM version is the outlier, not
an upstream data problem.

**Why:** a general-purpose canonicalization helper (meant for equality checks /
seat-continuity matching) got reused as if it were the DB storage format.

**How to apply:** if a portal team-performance/report page reads real but the
sales numbers are silently zero (not an error page), suspect this exact
pattern — grep for `.keys()` of a canonical/`toCanonicalPortalHrId(...)` map
feeding into `fetchPortalSalesRecords`/`salesQueryHrIds`. The fix is to track
the raw hrId alongside the canonical key (e.g. a second map
`canonical -> rawHrId`) and query with the raw form, mirroring the MRs
Performance pattern.

**FIXED 2026-07-04**, shipped as [PR #813](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/813)
(branch `codex/fix-dsms-performance-hrid-and-period-filter`, from worktree
`.claude/worktrees/dsms-performance-fix`) — owner approved commit+push+PR.
Added `medRepCanonicalToRawHrId` map and used
raw hrIds in `salesQueryHrIds`; re-verified live against prod data (Ali
Mohamed A-12/line 2: went from all-EGP-0/no-periods to real EGP figures,
per-DSM achievement 53–74%, periods 2026-01..05 all present). Also added
multi-period support (`getNsmDsmPerformance` now takes `period?: string |
string[] | null`, exported `normalizeTeamComparisonPeriods` for reuse) and a
toggleable multi-select period-pills UI (was single-select only) per the
owner's explicit ask. Lint/typecheck/313 unit tests pass; `npm run build`
not run — known pre-existing Turbopack/worktree-junction failure unrelated to
this change (see [[worktree-junction-breaks-turbopack]]).

**Process note:** mid-fix, EnterWorktree was called correctly but the first
round of Edit/Read calls used the PRIMARY repo's absolute path instead of the
worktree's path, so the fix briefly landed in the shared working directory
while another session was reportedly active there — caught via a failed live
re-test (worktree dev server still showed zero data), confirmed via `git
diff` (only my own edits, nothing pre-existing mixed in), then corrected by
copying the edited files into the worktree and `git checkout --` on the two
files in the primary to restore it to clean HEAD. Lesson: after EnterWorktree,
double-check that Read/Edit/Bash calls target the worktree's absolute path,
not the primary repo path — the tool switches the logical session directory
but does not rewrite absolute paths you pass yourself.
