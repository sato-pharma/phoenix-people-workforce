---
name: a-baseline-diff-can-be-another-sessions-unpushed-migration
description: "Before refreshing supabase/schema/production.sql, look in every local worktree for an uncommitted migration that explains the diff — migrations go on production by hand BEFORE their PR exists, so a live session may already carry the same baseline change."
metadata:
  node_type: memory
  type: project
  originSessionId: fb7acb22-dea4-40c6-b1bb-b67f01bff48a
  modified: 2026-11-19T00:55:24.619Z
---

On 19 Nov 2026 about 03:10 Cairo the owner said "Refresh schema baseline". `schema-baseline.mjs --check` read 1 of 8,054
objects differing; `--write` showed it was `phoenix_crm_report_manager_visits` (a companions arm commented 2026-11-19),
not the function an earlier summary had named. Nothing on main or on GitHub carried its migration. The source was the
code-review session's worktree `_wt-review-last-50-prs` (branch `codex/fix-review-findings`): an UNTRACKED migration
`20261119023448_phoenix_crm_report_credits_every_companion.sql`, already applied to production, and its own
`production.sql` edit with the same 19 added lines. No duplicate PR was opened; the worktree and its empty branch were retired.

**Why:** the ship rule applies migrations to production before the merge, so for a while production is ahead of
every pushed branch, and the baseline check reads that window as drift.

**How to apply:**
- Read the diff `--write` produces (it names the object; a summary's guess can be wrong).
- Then search each worktree's recent `supabase/migrations/*.sql` for a line from that diff: list `git worktree list`
  into a file and loop over named folders; a recursive grep from the workspace root is refused by the bash hook.
- If a live session already carries it, leave the baseline to that session's PR and report that; refresh only when no
  one does.

Related: [[retiring-your-own-worktree-leaves-an-empty-folder]].
