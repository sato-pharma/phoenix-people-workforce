---
name: other-approvals-history-duplication-fix
description: "Other Approvals hub's My Requests/History tabs still duplicated leave/excuse/plan items from their dedicated hubs — fixed PR #1206, MERGED+LIVE 2026-07-20."
metadata:
  node_type: memory
  type: project
  originSessionId: 97ce90b0-c153-40d3-a237-13acfefeb1ba
  modified: 2026-07-20T12:44:16.044Z
---

Owner reported (2026-07-20): "weekly plans are still showing in other approvals." Reproduced
against real prod data (Marketing Manager A-9, real HR_ID): the "Pending approvals" tab of
"Other Approvals" (`/admin/approvals-hub`, `/employee-portals/approvals-hub`) was already
correctly filtered (leave/excuse/weekly_plan excluded, per [[weekly-plan-approvals-in-action-center]]
and [[approvals-hub-vacation-excuse-build]]'s original build). The **My Requests** and **Approval
History** tabs were not — every leave/excuse/plan decision a person had ever made or submitted
kept showing there too, duplicated from that module's own dedicated hub (Vacation/Excuse/Plan
Approvals each have their own My Requests + History tabs, see [[approvals-hub-ceo-oversight-tabs]]).
A-9 had 8 plan + 3 excuse + 1 leave entries leaking into Other Approvals' History tab alone.

**GOTCHA that made this non-trivial:** `src/lib/approvals-hub/service.ts` builds each dedicated
hub's own My-Requests/History tab by calling the SAME shared `getMyRequestItems`/
`getMyApprovalHistory` (in `src/lib/action-center/service.ts`) and filtering the result down to
`item.module === "weekly_plan"` (or `"leave"`/`"excuse"`). **Stripping a module out of those two
shared functions directly would silently break the dedicated hub's own tabs** — they're the same
data source, just filtered oppositely. Confirmed via `tests/approvals-hub.test.ts:268` which
asserts the dedicated-hub filter is literally `.filter((item) => item.module === "weekly_plan")`
against the shared functions' output.

**Fix (PR #1206, branch `codex/plan-history-leak`, off origin/main):** filter
`myRequests`/`historicalItems` at the PAGE level (both `app/(admin)/admin/approvals-hub/page.tsx`
and `app/employee-portals/approvals-hub/page.tsx`), reusing the existing `MIGRATED_DEEPLINK_BASES`
Record (already the single source of truth for "which modules moved to a dedicated page", previously
only used to redirect stale `?module=X` deep links) as the exclusion set:
`rawMyRequests.filter((item) => !MIGRATED_DEEPLINK_BASES[item.module])`. Left
`getMyRequestItems`/`getMyApprovalHistory`/`getActionCenterDeepLinkItem` completely untouched.

Owner's scope decision when asked: fix leave+excuse the same way too (not just plan) — the
"Pending approvals" tab already treated all three uniformly, so My Requests/History now do too.

**Validated:** typecheck/lint/424 tests all green. Re-verified against real prod data before/after:
Other Approvals My-Requests+History → 0 leave/excuse/plan entries after the fix (down from 8+3+1
for the one manager tested); the three dedicated hubs independently re-checked unaffected (still
show the same counts as before — vacation 1, excuse 3, plan 8 history + 1 live pending).

**Process note:** built in an isolated worktree (`_wt-plan-history-leak`) rather than the primary
checkout because [[parallel-session-swarm-hazard]] flagged another live session (PID 27768) in the
primary folder at session start — read-only investigation (grep/Read, plus a throwaway dev server
on port 3009/3011 pointed at prod per [[local-browser-verify-gotchas]]) was done in the primary
tree, but all edits happened only in the worktree.
