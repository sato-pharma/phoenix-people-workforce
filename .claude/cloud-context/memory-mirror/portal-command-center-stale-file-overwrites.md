---
name: portal-command-center-stale-file-overwrites
description: "GOTCHA — parallel-session squash merges repeatedly overwrote portal-command-center.tsx with a STALE copy, dropping exports/dispatch and breaking prod twice"
metadata: 
  node_type: memory
  type: project
  originSessionId: bc83c359-fb52-486a-8169-9546e58de8bd
---

`src/components/employee-portal/portal-command-center.tsx` is edited by many parallel sessions. On 2026-06-28 a chain of squash merges (#568, #569) committed a STALE copy of this file that predated PR #565, which:
1. Dropped the `PendingCountsUnavailable` export → Turbopack build failed (`Export PendingCountsUnavailable doesn't exist`) — `marketing-manager-command-center.tsx` imports it. **Two** production outages before PR #570 fixed it.
2. Silently dropped the MM/DSM/NSM dispatch in `PortalCommandCenter({ snapshot, access })` switch → Marketing Manager / District Manager / National Sales Manager fell through to `StandardCommandCenter` (generic dashboard). Fixed by PR #571 (`6051d167`).

**Why:** squash merge replays whatever file blob is on the branch; if the branch's base was stale, the merge silently reverts newer exports/logic in the same file even though the PR "looks" unrelated.

**How to apply:**
- Before merging ANY PR that touches `portal-command-center.tsx`, diff the PR head's copy against the last-known-good commit, not just the local working copy: `git show <pr-head>:src/.../portal-command-center.tsx | grep -n "PendingCountsUnavailable\|export function PortalCommandCenter\|case \"Marketing Manager\""`.
- The canonical signature is `PortalCommandCenter({ snapshot, access })` with switch cases for Product/Group Product Manager (PmGpm), Marketing Manager, District Manager, National Sales Manager, medical rep, else Standard. `access` is threaded from `app/employee-portals/page.tsx`.
- Required exports that other files import: `PendingCountsUnavailable` (needs `AlertTriangle` in lucide import), `egp`, `SectionShell`, `PremiumNavTile`, etc.
- Salary rule still applies — landing payslip tiles use `monthLabel(latestPayslip.month)`, never `egp(netSalary)`. See [[portal-no-salary-on-landing]].
- Vercel CLI `vercel ls` age column lagged/misled during this incident; verify the live prod commit with `gh api "repos/Phoenix-HR/phoenix-people-workforce/deployments?environment=Production&per_page=1" --jq '.[0].sha[0:8]'` and `vercel ls --meta githubCommitSha=<sha>`.

Related: [[portal-sidebar-real-source]], [[parallel-session-swarm-hazard]].
