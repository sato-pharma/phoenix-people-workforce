---
name: actions-center-consolidation
description: "Consolidated two-tab \"Actions\" page (Awaiting my action + My requests) across admin shell + employee portal; marketing excluded; portal inbox scoped."
metadata: 
  node_type: memory
  type: project
  originSessionId: b87d285f-1478-474e-b82a-93a69235ee66
---

PR #341 (branch `codex/actions-center-phase1`, off main) consolidates approvals + request-tracking into one **Actions** page in BOTH shells: `/admin/action-center` (renamed "Action Center"→"Actions") and NEW `/employee-portals/actions`. Two tabs: **"Awaiting my action"** (approver inbox) + **"My requests"** (own submissions: vacation/excuse/outstation/weekly-plan/resignation, with live status).

LOCKED design decisions (do NOT regress):
- **Marketing is EXCLUDED** from this consolidated inbox everywhere — it keeps its own dedicated inbox (`/workspace/marketing-requests` + portal equivalents). Owner's explicit instruction.
- Inbox aggregation lives in `src/lib/action-center/service.ts` → `getAwaitingMyActionItems(access, audience)`. **SECURITY**: audience `"portal"` aggregates ONLY access-scoped sources (vacation role-scoped to team/hierarchy/line + excuse scoped to caller's manager_hr_id). The unscoped HR/admin sources (all resignations, all outstation, contract renewals) are admin-shell only — NEVER aggregate them for a portal manager.
- "My requests" via `getMyRequestItems` (same file). Tab labels are "Awaiting my action" / "My requests" (owner chose clearer English over "by me/for me").
- pending-count badge reuses `getAwaitingMyActionItems` (audience-aware) so the badge count always equals the inbox list.

Built on Opus 4.8, 2026-06-19. Phase 3 backlog: wire the weekly-plan approver side into the inbox; deep links from "My requests" into each module's page.

INCIDENT during this build: a concurrent session was editing the SAME main worktree (`phoenix-workforce`) on `codex/work-from-production` (adding launch-desk/world-room) and switched the branch mid-build. Resolved by isolating to a dedicated worktree `_wt-actions-center`. Reinforces [[parallel-session-swarm-hazard]] — one session per worktree.
