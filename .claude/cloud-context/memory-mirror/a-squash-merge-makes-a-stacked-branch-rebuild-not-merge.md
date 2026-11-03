---
name: a-squash-merge-makes-a-stacked-branch-rebuild-not-merge
description: "After a parent PR squash-merges, do NOT merge main into the branch stacked on it — every line of the parent reappears as a conflict. Reset the child to origin/main and re-apply its OWN diff (git diff <parent head> <child head>) with git apply -3."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e94a655d-2c8b-49f4-9c2c-ad15fddfe252
  modified: 2026-11-03T11:28:59.944Z
---

`main` is squash-merge only (`delete_branch_on_merge` on, `gh pr merge --squash`). So when PR A
merges, its commits do **not** become ancestors of `main` — one new commit with the same *content*
does. A branch B that was stacked on A still carries A's original commits, and git has no way to
know they are the same work.

**What that means in practice:** `git merge origin/main` on B produces a conflict for *every hunk of
A*, not just for B's own. Measured 2026-09-26 on the Phoenix CRM Phase 2 stack (E3 → E2 → D3): the
first merge after E3 landed reported conflicts in 2 files and silently rerere-resolved 5 more from a
resolution recorded in a different context — which is worse than the conflict, because it looks clean.

**Do this instead — rebuild the child from its own patch:**

```bash
git -C <child worktree> merge --abort              # if you already started one
git diff <parent-head-sha> <child-head-sha> > /tmp/child.patch   # the child's OWN change set
git fetch origin && git reset --hard origin/main
git apply -3 /tmp/child.patch                      # 3-way; usually clean, at most one real conflict
# run the tests, commit with the original message, then:
git push --force-with-lease origin <child branch>
```

`--force-with-lease` on your own open PR is fine: the PR survives, its number and body are kept, and
CI re-runs on the new head.

**Two things that go wrong if you merge instead.** The conflict volume is large enough that you stop
reading and start accepting, and `rerere` replays earlier resolutions into hunks they were never
written for. Both were live on 2026-09-26.

**A way with no force push, when the child holds the parent's whole tip** (3 Nov 2026, pull request 46
on 42): first prove `git diff <parent tip> <squash commit>` is EMPTY, then `git merge -s ours
<squash commit>` and an ordinary `git merge origin/main`. The plain merge had conflicted in 5 files;
this brought in only what landed after the squash. `-s ours` discards that commit's side, so without
the empty diff it silently loses work.

**Get the parent sha BEFORE you reset** — `git log --oneline -3` in the child worktree, or the sha
the child branched from. After `git reset --hard` it is only in the reflog.

**Prefer not to stack at all when the steps are independent.** Each PR off `origin/main` costs
nothing extra and cannot hit this. Stack only when the later step genuinely needs the earlier one —
in Phase 2 each migration replaced `phoenix_crm_save_visit` on top of the last, so it had to.

Related: [[git-branch-d-is-not-a-safety-gate-after-a-squash-merge]] — the same squash asymmetry, seen
from the other end.
