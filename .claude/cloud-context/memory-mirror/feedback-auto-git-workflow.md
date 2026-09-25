---
name: feedback-auto-git-workflow
description: "SUPERSEDED 2026-09-16 — the owner now wants commit, push and the PR done AUTOMATICALLY, and approval ALWAYS before merge (AGENTS.md section 2, user CLAUDE.md). This file keeps the June 2026 history of the old ask-before-every-git-action rule (PRs 645 and 651, both reverted by him); never follow that old rule."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 356f414c-eaa3-477f-a208-d2f89b957d55
---

🔴 **SUPERSEDED 2026-09-16 — do NOT follow the old rule below.** Owner: *"auto commit auto push auto PR, must take
approval before merge"*. Commit, push and open the PR without asking (branch first, never onto `main`, stage only
the task's files); ALWAYS ask before a merge; never `gh pr merge --auto`. Still ask first for a force-push on a
shared branch and for any branch or worktree removal; production migrations follow AGENTS.md sections 6 and 8.
The June history below explains why the rule was once the opposite — it is not a reason to ask before a commit
or a PR now. (Annotated 2026-09-17 by the settings review.)

## THE OLD RULE (June 2026, superseded)

**Always ask for approval before:** commit, push, PR creation, merge, rebase, reset, branch deletion, force push, applying migrations, production-impacting changes, bulk updates, deletes, auth changes, RLS changes, and any destructive operation.

**May run automatically (no approval needed):** `git status`, `git diff`, branch inspection, staging files, commit preparation, validation runs, read-only checks.

**Why:** The user tried auto-execute Git workflow TWICE (PR #645 on 2026-06-29 and PR #651 on 2026-06-30). Both times the user immediately reverted it saying the behavior felt wrong. They explicitly want Claude to stop and ask before every Git action — even when tests pass.

**How to apply:** Before every commit, push, PR, or merge — briefly explain what you're about to do and ask. Only skip asking for read-only/inspection commands.

## History of attempts (do not repeat these)

- `bd495b1b` / PR #645 (2026-06-29 night): Added fully-automatic workflow — reverted by user (PR #648)
- `a2832830` / PR #651 (2026-06-30): Added validate-first-then-auto workflow — reverted by user (PR this file references)
- Both times user said "nothing changed, I want the old way"

## Still needs explicit sign-off

- Production migrations (Supabase prod ref `ozucdzovmcqvepbozvqf`)
- Destructive SQL (DROP TABLE, TRUNCATE, DELETE without WHERE)
- `git push --force` on shared branches
- Production environment-variable changes
- Any production rollback

See also [[feedback-task-tracker]], [[one-prod-deploy-per-task]].
