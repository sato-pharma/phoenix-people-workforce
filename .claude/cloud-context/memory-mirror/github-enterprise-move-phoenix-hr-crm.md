---
name: github-enterprise-move-phoenix-hr-crm
description: "The move to GitHub Enterprise under the name Phoenix-HR-CRM, started 2026-11-04 on his word. Prep branch codex/enterprise-move is a draft that must merge only after the transfer. Re-read before trusting."
metadata:
  node_type: memory
  type: project
  originSessionId: 8a678e86-b367-4ec0-a671-687cc891d84f
  modified: 2026-11-03T22:34:14.337Z
---

His words, 2026-11-04 about 00:30 Cairo: "start migration to enterprise Phoenix-HR-CRM".

Read at that time: `github.com/Phoenix-HR-CRM` and `api.github.com/users/Phoenix-HR-CRM` answer 404, so no organization of that name exists. `github.com/enterprises/<anything>` redirects to login, so that proves nothing about an enterprise slug. The `gh` token has no `read:enterprise` or `admin:org`. `gawishtheit` belongs to no organization. `Phoenix-HR-OAG` and `Phoenix-Sato-Pharma` exist, with neither visible to this login.

Prep: branch `codex/enterprise-move`, worktree `F:\Phoenix Workforce\_wt-enterprise-move`, commit `b0c828364`, draft PR on `gawishtheit/phoenix-people-workforce`. Merged before the transfer, it names an owner that does not hold the repository.

**Why:** Enterprise needs an organization, and a personal account cannot hold it. Creating the organization and buying the plan are his.

**How to apply:** the order is in the PR body. Three traps:
- A registry path must be lower-case: `ghcr.io/phoenix-hr-crm/...`.
- GHCR images stay on the personal account after a transfer, so the fallback image must be rebuilt.
- `infra/code-backup/backup.sh` backs up one owner and refuses below `CODE_BACKUP_MIN_REPOS`, so repositories left on `gawishtheit` drop out of the backup and the minimum may need changing.

Sessions may not run `railway service source connect`; he runs it. A refused connect left production's source empty on 2 Nov, so connect only once Railway's `githubRepoBranches` answers for the new owner. See [[github-account-suspended-2026-11-02]].
