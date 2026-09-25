---
name: worktree-audit-20260626
description: "Deep one-by-one audit of 18 stale worktrees and their PRs on 2026-06-26 — recurring pattern is squash-merge leaving dangling branches that look unmerged but aren't."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1b1d2e15-3cee-420a-8813-657eeed015bf
---

**Context:** owner had accumulated ~18 worktrees (`_wt-*` under `F:\Phoenix Workforce\`, plus `.codex-worktrees\*`) from past sessions, many with open PRs or uncommitted "dirty" changes. Did NOT trust a pre-existing summary audit at face value — re-verified every item against live git/GitHub state before acting, per [[never-skip-ask-until-resolved]] and [[compaction-replay-mistaken-for-live-state]].

**Recurring pattern found (the main lesson):** a "dirty" worktree or an "N commits ahead" branch is NOT reliable evidence of unshipped work. Several large feature branches (`5bbfadcd` "Metabase analytics foundation" PR #524, `eb1d9054` "complete excuse approval workflow notifications") bundled in fixes that were *also* independently drafted on other dangling branches — same logic, sometimes byte-identical, shipped under a different commit SHA. **Always diff branch content against current main before assuming a stale branch holds lost work** — `git log main..branch` showing commits is not proof those commits' content is missing from main.

**Items where the pre-existing audit was itself wrong** (don't trust a cached summary, even one written carefully):
- `_wt-sos-overview-trim` was labeled "merged via PR #529" — actually a different branch (`fix/analytics-sos-overview-trim`) with its own *open*, real PR #533 (merged this session).
- Two worktree paths in the original audit (`_wt-pm-gpm-line-scope`, `.codex-worktrees/sales-linkage-manager-hotfix`) no longer existed at all — already cleaned up before the audit ran.
- A worktree at `C:\Users\satoh\scoop\buckets\copilot-worktrees\...` wasn't in any prior audit — found via `git worktree list`, turned out to be a linked worktree of the *same* repo (shared `.git`), which is how an orphaned `git stash` entry (`WIP on codex/portal-identity-badge-redesign`) was discovered — stashes are shared across all worktrees of one repo and invisible to any per-worktree audit.

**Genuinely real, unshipped work found and acted on:**
- `codex/builder-preview-login` (3 commits, security-relevant CSP/CSRF origin-gating for Builder.io preview) — opened as [PR #534](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/534), merged.
- `fix/sidebar-hydration-bounce` / PR #516 and `fix/marketing-roi-fast-customer-map-index` / PR #519 — both confirmed fully superseded by `5bbfadcd`, closed.
- `[codex] fix sales V-AF vacancy validation` / PR #518 (9 commits) — fully stale fork (273 behind main), every commit's content already shipped under different SHAs; main's vacancy-matching logic (`src/lib/sales/employees.ts`) is now *more* complete than this branch's version. Closed.
- `codex/portal-overview-redesign` / PR #444 (6 commits, from the reverted 2026-06-21 day) — mixed case: coaching-analytics part superseded, but overview-dashboard part targeted `employee-portal-dashboard.tsx`/`MedicalRepOverviewPage`, which stopped being the active portal home page after PR #449 switched it to `PortalCommandCenter`. Closed as obsolete; spawned background task `task_eb80d042` to rebuild the still-missing weekly-trend/double-visit/pacing widgets fresh against `PortalCommandCenter`.
- One real near-regression caught: an uncommitted 1-line diff (`notifyHrVisibilityRecipients` channels) would have reintroduced HR double-emailing — traced both code paths to the same `HR_NOTIFICATION_EMAILS` env var to confirm before discarding.

**Net result:** ~18 worktrees/branches removed, 2 dangling branches deleted, 9 empty leftover folders cleaned, 5 PRs closed as superseded (#445, #516, #518, #519, #444), 2 PRs merged (#515, #533), 1 new PR opened+merged (#534), 1 follow-up task spawned. Disk and `git worktree list`/PR queue both fully clean afterward.

Relates to [[portal-overview-dashboard-build]], [[compaction-replay-mistaken-for-live-state]], [[never-skip-ask-until-resolved]].
