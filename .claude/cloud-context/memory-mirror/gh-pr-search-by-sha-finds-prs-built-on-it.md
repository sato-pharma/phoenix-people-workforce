---
name: gh-pr-search-by-sha-finds-prs-built-on-it
description: "`gh pr list --search <sha>` returns ANY PR whose commits include that SHA — a later PR built on top of it, a roll-up — not the branch's own PR; never use it to call a worktree's work merged"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6354201e-9598-46d0-a8a5-f03e48032bbe
  modified: 2026-10-29T18:36:55.512Z
---

🔴 **`gh pr list --state all --search <worktree tip sha>` answers "which PRs contain this commit", not "which PR is
this branch's own".** On 2026-10-29 it was used to call six `_wt-` worktrees "PR merged": four tips were plain
`main` commits, so it returned unrelated later PRs (`codex/marketing-queue-clear-reported`, `codex/upload-ai-suggest`);
two returned the ROLL-UP while the branch's own PR was CLOSED. The owner was told "merged PR 6485" for a folder
whose own branch never had a PR. Nothing was lost only because `new-session.mjs --remove` gates on its own.

**Why:** a commit appears in every PR whose range includes it — the base of a later branch, a roll-up's merged
members — so the first hit is rarely the branch's own PR.

**How to apply:** to decide whether a branch's work is on `main`, in this order:
`git merge-base --is-ancestor <tip> origin/main` (true → nothing to lose); else the branch's own PR by NAME and
its `headRefOid == tip` (CLOSED + a roll-up whose head contains the tip counts as landed); else byte-compare the
files the branch changed (`git diff --name-only $(git merge-base <tip> origin/main) <tip>`). A file that differs
is fine only when `git log <base>..origin/main -- <file>` shows main edited it later. In Git Bash set
`MSYS_NO_PATHCONV=1` or `./`-prefix the path, or `origin/main:.claude/...` fails silently and reads as "differs".
Related: [[a-reused-branch-name-finds-the-old-merged-pr]].
