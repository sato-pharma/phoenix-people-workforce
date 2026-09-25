---
name: planning-calendar-role-line-scope-2026-07-20
description: "Shared Planning Calendar visibility is role/line-scoped (owner decision 2026-07-20, 2 rounds), superseding the unconditional 2026-07-19 decision. BOTH PRs are merged and live — #1211 (GPM/NSM/PM/B-155) and #1212 (CEO/SA/DSM/RM), both 2026-07-20. DURABLE: use hrIdsMatch() for any HR_ID comparison, and \"product manager\" is a substring of \"group product manager\"."
metadata: 
  node_type: memory
  type: project
  originSessionId: 97ce90b0-c153-40d3-a237-13acfefeb1ba
  modified: 2026-07-20T18:01:16.942Z
---

The shared Planning Calendar (`isPlanItemVisibleToViewer` in `src/lib/weekly-planning/calendar-service.ts`, feeding `/admin/weekly-plans/calendar` + `/employee-portals/plans/calendar`) is **role/line-scoped**, not unconditional. This is the SECOND policy on this exact function in 2 days — check the code's own top-of-function comment for the current state before trusting this memory, since it may change again.

**Current matrix (2 rounds, same day — PR #1211 MERGED+LIVE covers the first 4 bullets below; PR #1212 PUSHED/not-yet-merged adds CEO/SA/DSM/RM):**
- CEO / Super Admin → unrestricted, see everything (PR #1212, explicit — was already the de facto fallthrough default, now pinned in code).
- Marketing Manager / Training Manager → unrestricted, see everything.
- Group Product Manager on Pedia line → Training Manager's plans + all Pedia plans.
- National Sales Manager on Pedia line → the Group Product Manager's plans + all Pedia plans.
- National Sales Manager on Anti Infective line → Training Manager's plans + all Anti Infective plans.
- Product Manager on Anti Infective line → Training Manager's plans + all Anti Infective plans.
- B-155 (Ahmed Sharaf, PM) → named HR_ID exception: Pedia + Anti Infective + Training Manager. Matches his existing `line_scope_override=['Pedia','Anti infective']` (see [[b155-two-line-pm-scope]]) but is hardcoded separately here, not derived from the override column — same "named exception" pattern as `PRODUCT_SCOPE_EXCLUSIVE_HR_IDS` in `marketing-requests/service.ts`.
- District Manager (PR #1212) → Training Manager's plans + their OWN line's Product Manager's plans ONLY — dynamically keyed off `viewer.lineName` (unlike the GPM/NSM/PM rules above, which are hardcoded to specific named lines since only one person holds each). Never Group Product Manager, never their own line's NSM, never other lines, never a peer District Manager — and, read literally, never their OWN plan either (matches neither grant; flagged to owner as a possible gap, not yet confirmed).
- Regional Manager (PR #1212) → District Manager's scope + their own line's Group Product Manager + the District Managers who report DIRECTLY to them. Needs a NEW `CalendarViewerContext.directReportHrIds: ReadonlySet<string>` (normalized HR_IDs), computed once per request in `getSharedPlanningCalendarWorkspace` by scanning the already-loaded employee directory for `hrIdsMatch(row.managerHrId, access.hrId)` — deliberately a flat one-level Set, NOT the old `reportsToManagerSeat`/`regionsWithinManagerHierarchy` hierarchy-walk helpers (those were removed 2026-07-19 and the hardening test explicitly guards against their return).
- Everyone else NOT named above (any other line's NSM e.g. B-122/CNS, and any role not covered) → default is UNRESTRICTED (kept the 2026-07-19 behavior).

**Why:** Owner gave this exact spec unprompted: "MARKETING MANAGER and training manager sees everybody plan .... pedia gpm sees training manager and all pedia plans pedia nsm sees gpm and all pedia plans .... regarding ahmed sharf special situations sees pedia and anti infective plans plus training manager .... anti infective nsm sees tm and all anti infective plans , anti infective pm sees tm and all anti infective plans". Real org data used to build the matrix: A-8=Pedia GPM, A-12=Pedia NSM, B-157=Anti Infective NSM, A-10=Anti Infective PM, A-9=Marketing Manager (Head Office), A-7=Training Manager (Head Office), B-122=CNS NSM (unlisted, kept unrestricted).

**How to apply:** Before touching `isPlanItemVisibleToViewer` again, read its current top-of-function comment AND `tests/weekly-plan-calendar-owner-scope.test.ts` (has the full matrix as executable assertions) AND `tests/weekly-plans-hardening.test.ts` (has regex guards on the shape) — these are the source of truth, this memory is a summary that will go stale. **This function's history makes it a magnet for churn** — 2026-07-19 removed same-line/hierarchy fencing entirely (unconditional visibility), 2026-07-20 added this role/line matrix back but with DIFFERENT logic (pure role+line+HR_ID, no topology/manager-seat/region functions) — don't assume either direction is "final."

**Gotchas hit while building this:**
1. `normalizeHrIdForAccess("B-155")` returns `"b155"` (lowercased, dash-stripped) — comparing it against the raw literal `"B-155"` silently fails and falls through to whatever the default case is. Use `hrIdsMatch(a, b)` for any HR_ID comparison, never a manual normalize-then-`===`. My own test suite caught this before it shipped (a CNS-line item wrongly appeared visible to the B-155 viewer) — see [[hr-id-normalization-fix-2026-07]] for the general pattern.
2. `"product manager"` is a substring of `"group product manager"` — a plain `.includes("product manager")` title check (the pattern used everywhere else in this function) would wrongly ALSO match Group Product Manager items. Only matters where a rule must grant Product Manager but deliberately exclude GPM (District/Regional Manager) — needed a dedicated exact-match helper (`itemIsExactlyProductManager`) instead of the usual substring one. Caught by reasoning through it before writing the code, not by a failing test — worth double-checking by hand any time a new title-substring check is added near "product manager"/"group product manager".
3. `pnpm run typecheck` can pass cleanly on a stale `.tsbuildinfo` even after a required field is added to a shared type and a dependent file isn't updated — TS's incremental build didn't invalidate the dependent test file's check that time. `rm tsconfig.tsbuildinfo` before trusting a clean typecheck result after a type-shape change in this file specifically (or generally, when a typecheck pass feels surprising).
4. Pre-push gate can fail with nonsense `.next/dev/types/routes.d.ts` syntax errors if a `next dev` process was ever run in the same worktree — `rm -rf .next` fixes it, not a code change. Already documented in [[approvals-hub-vacation-excuse-build]]; recurred here.

**Verification method:** built in isolated worktree `_wt-plan-calendar-scope` (branch `codex/plan-calendar-role-scope`), verified against REAL production data by querying `employee_plan_headers` for the relevant month's pending/decided plans, then running a local dev server (`.env.local` points at prod Supabase — read-only, see [[local-browser-verify-gotchas]]) with `/api/dev-auth` impersonation per role, hitting `/api/weekly-plans/calendar?year=2026&month=7` directly and diffing the returned employee/line set against the expected matrix. Round 1: all 7 real people involved (A-7/A-8/A-9/A-10/A-12/B-155/B-157) plus the unlisted-role default (B-122) matched exactly. Round 2 (DSM/RM) used a natural experiment: the org has exactly ONE active Regional Manager (PD-0001/Hany Saad, Pedia line, 3 of 6 Pedia DSMs report to him) — a Pedia DSM under him vs. a Pedia DSM reporting straight to the NSM returned IDENTICAL results, confirming the District Manager rule is line-based not hierarchy-based; the RM himself, an Anti Infective DSM, and a CNS DSM (no CNS-line PM exists at all) all matched expectations too. One transient "fetch failed" mid-verification (likely a brief Supabase connection blip under rapid successive curl calls) resolved cleanly on retry — not a code issue.

## 2026-09-04 — #1212 merged the same day

The description said **"PR #1212 (CEO/SA/DSM/RM) PUSHED, not yet merged."** `gh pr view 1212` —
**MERGED 2026-07-20**, *fix(weekly-planning): add CEO/Super Admin/District/Regional Manager*. Both
halves of the owner's two-round decision are live.

The four numbered traps at the end of this file are the reason it stays — the `hrIdsMatch` one in
particular now has a much broader form in `AGENTS.md` §2.1 (HR ids are mixed case, so a plain
`.eq` silently under-returns).
