---
name: an-autofix-conflict-event-can-name-a-stale-head
description: A desktop-app Auto-fix <ci-monitor-event> carries the head SHA it judged — read it, because an event that arrived mid-turn can describe a conflict you already fixed two merges ago.
metadata:
  type: project
---

Auto-fix reports what GitHub said **at the moment it read**, and the event names that head in
parentheses ("GitHub's verdict for head 5633029157"). It arrives as a mid-turn message, so on a
branch you are actively merging it can land **after** the fix.

On 23 October 2026 two identical conflict events for PR #6310 both named `5633029157` while the
branch was already at `3653a1a88`, `mergeable: MERGEABLE`, containing `origin/main`.

**Why it matters:** `sync_with_base_branch` or another `git merge` on an already-merged base is not
harmless — it is a second empty merge commit, a new head, and another full CI run (~28 billable
minutes, AGENTS.md §6).

**How to apply:** before acting on a conflict event, compare its head SHA with
`gh pr view <n> --json headRefOid,mergeable,mergeStateStatus` and
`git merge-base --is-ancestor origin/main HEAD`. If the branch already contains the base, say the
event is a stale read and do nothing. Note also that `mergeStateStatus: BLOCKED` with
`mergeable: MERGEABLE` means *checks unfinished*, never a conflict — and that GitHub answers
`UNKNOWN` for a few seconds after every push while it recomputes.

The same stale-sha behaviour is noted in passing by
[[a-push-that-prints-new-branch-means-the-pr-already-merged]]; this note is the full treatment of the
conflict-event case.
