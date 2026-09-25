---
name: line-scope-fixes-pr544-and-swarm-redundancy
description: "2026-06-27 — most \"fix this part\" tasks were already shipped by the parallel swarm; only line-scope was unique → PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 494f17af-c570-4f6e-adc2-64ed0fc33538
---

On 2026-06-27 the owner fed a batch of "X — looks complete, fix this part" tasks
(probation manager read-only, organogram TM/MM access, action-center mojibake,
pagination extraction, probation line-matching). A health check revealed **most were
already shipped to `main` by parallel swarm sessions** and were redundant:

- `canViewAllProbation` / `canReadAllProbation` (+ CEO) — already in `origin/main`.
- Action-center mojibake `â€¦`→`…` — already in `origin/main` (PR #515, byte-identical).
- `canAccessCompanyOrganogram` access helper (incl. TM/MM) — already in `origin/main`.

**Only genuinely-new work** (NOT upstream): replacing probation `isSameLine()` text
compare with `sameWorkforceLine()` (numeric line_id first) in
`src/lib/probation/service.ts`; the same in employee-portal vacancies scope
(`src/lib/employee-portal/service.ts`); and the employee-portal organogram page
branching on `canAccessCompanyOrganogram`/`isCompanyScoped` so TM/MM aren't
redirected (`app/employee-portals/organogram/page.tsx`). Shipped as
**PR #544** (`codex/line-scope-fixes`), built in an isolated worktree off
`origin/main`; typecheck+test+lint+build all green.

**Untangle outcome (same day):** the entangled portal branch
`codex/portal-mobile-responsiveness` (`d0ca0683`: portal redesign + font fix +
shared PaginationControls component) turned out **100% already in `origin/main`** —
all 12 files byte-identical to upstream → branch fully redundant, discarded. The
`navy`/`navy-light` tailwind tokens were **dead** (referenced nowhere) → dropped.
Only 2 genuinely-unmerged pieces remained → **PR #546**: vacation-report pagination
dedup (use the now-upstream shared control) + the 3 TM coaching sub-pages
(coaching / create-coaching-report / field-coaching) converted from legacy
AdminPageHero to EmployeePortalPageShell. So the net of the whole 2026-06-27 batch =
**PR #544 (line-scope) + PR #546 (portal-UI)**; everything else was already shipped.

**Why:** before "fixing" dirty-tree work, diff each piece against `origin/main` — the
swarm may have already merged it. Whole-file blob-hash equality (or empty
`git diff origin/main <branch> -- <file>`) is the decisive duplicate check. See
[[parallel-session-swarm-hazard]] and [[compaction-replay-mistaken-for-live-state]].

**How to apply:** for line/territory scoping always use `sameWorkforceLine()` from
`@/lib/workforce/hierarchy-resolver` (id-first, text fallback), never raw
`normalizeLineName()` string compares. See [[double-visit-gpm-line-id-scope]].

**Swarm hazard reinforced (live):** the shared primary tree
(`F:\Phoenix Workforce\phoenix-workforce`) had its branch switched AND received
commits onto a branch I had just created, by a parallel session, mid-session. Never
`git branch -D` a branch in the shared tree on a "not fully merged" error — a parallel
session may have committed onto it. Isolate all real work in a worktree off
`origin/main` and push fast.
