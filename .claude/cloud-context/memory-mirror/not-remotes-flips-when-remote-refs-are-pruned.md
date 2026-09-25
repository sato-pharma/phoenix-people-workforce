---
name: not-remotes-flips-when-remote-refs-are-pruned
description: "`git log <branch> --not --remotes` is NOT a backup check here — squash merge + delete_branch_on_merge means it reads 0 while the stale ref lingers, then reports EVERY commit as unpushed once pruned. Gate branch deletion on the merged PR, never on this count."
metadata:
  node_type: memory
  type: reference
  originSessionId: 55343d83-8cde-4f3d-85d4-cf526b689702
  modified: 2026-08-23T20:35:00.000Z
---

**The trap.** The natural "is this branch backed up?" check —

```
git log --oneline <branch> --not --remotes | wc -l    # "unpushed commits"
```

— answers a different question than it appears to. It compares against **local remote-tracking
refs**, which in this repo diverge from reality in two opposite ways:

- **While a stale `origin/<branch>` ref survives** (`git fetch` never prunes — see
  [[stale-remote-tracking-ref-after-merge-delete]]) it reads **0**, i.e. "safe", even though the
  remote branch was deleted at merge time.
- **Once that ref is pruned**, it reports **every commit on the branch** as unpushed. PRs here merge
  by **squash**, so the branch's individual commits are never ancestors of `main` and there is
  nothing left to compare against.

Same branch, same commits, opposite verdicts — decided entirely by whether someone happened to run
`git fetch --prune`.

**Confirmed live 2026-08-05.** Two orphan scans four minutes apart, no commits in between and no
worktree on any of them: **15 branches flipped from 0 to non-zero.**
`codex/fix-sfe-manager-nav-dead-links` went 0 → **8 unpushed** while **PR #1776 was merged and
serving production**. `codex/crm-connector-testable-guards` 0 → 8, `codex/live-sheet-freeze-merge-fix`
0 → 6. The tell was the ratio: **63 local branches against 27 remote-tracking refs.**

Had that count been used as the deletion gate, all **13** provably-merged branches in that cleanup
would have been refused, each with a false claim that it held unbacked work.

**The rule: gate branch deletion on the merged PR, exactly as AGENTS.md §5 says.**

```
gh pr list --head "$br" --state all --json state --jq '[.[].state] | join(",")'
# delete only on MERGED — CLOSED means the work was rejected, not landed
```

`--not --remotes` is still meaningful for a branch with **no PR at all**: there, a non-zero count
does mean commits live only on this disk (the 2026-08-05 scan found 13 such branches holding 53
commits, incl. `fix/revoke-1602` with 16 and two `backup/*` pre-rebase branches). Use it to find
work at risk — never to authorize a deletion.

**Confirmed a second time 2026-08-23**, on the reassuring side of the flip. Clearing merged branches
after a worktree cleanup, `git log --oneline codex/marketing-complete-reused-venue-evidence --not
--remotes=origin` printed **nothing at all**. GitHub had already deleted that remote branch
(`git ls-remote --heads origin <branch>` → **0 lines**), but `refs/remotes/origin/codex/marketing-
complete-reused-venue-evidence` was still sitting locally at the branch's own tip `5d49bdad` — so the
check was comparing the branch against itself and could only ever return empty. The
`git remote prune origin` run straight afterwards cleared **8** such refs in one go.

**Read an empty `--not --remotes` as “this check did not run”, never as “nothing is unpushed”.** One
line separates the two readings:

```bash
git for-each-ref "refs/remotes/origin/$br"   # still there? then the check above proved nothing
git ls-remote --heads origin "$br" | wc -l   # 0 = GitHub deleted it; the local ref is a ghost
```

Related: [[stale-remote-tracking-ref-after-merge-delete]] (the same pruning gap, on the push path),
[[merged-pr-does-not-make-a-worktree-retirable]] (the merged-PR signal has its own staleness),
[[failed-git-piped-to-wc-l-reads-as-zero-dirty]] (the other check here that silently stops checking).
