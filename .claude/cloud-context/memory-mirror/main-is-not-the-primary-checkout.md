---
name: main-is-not-the-primary-checkout
description: "In this repo a WORKTREE holds `main`, so the primary checkout is on something else and `git checkout main` there aborts. Reporting ahead/behind from HEAD inside the primary produces real numbers with the wrong LABEL — which nearly caused a reset --hard on a third session's branch."
metadata:
  node_type: memory
  type: project
  originSessionId: bb208cb6-364e-4bfd-9cf7-551847e48bcf
  modified: 2026-09-05T16:54:37.563Z
---

**The fact.** A worktree holds `main` — `_wt-dashboard-follow-closing` on 2026-09-05 — and git forbids
two worktrees from checking out one branch. The primary checkout is therefore normally on a feature
branch, and `git checkout main` there aborts:

```
fatal: 'main' is already used by worktree at 'F:/Phoenix Workforce/_wt-dashboard-follow-closing'
```

**Two sessions hit this within hours**, from opposite directions. The first ran `git checkout main`
in the primary and lost a minute to the abort. The second ran `git rev-list --count origin/main..HEAD`
and `git merge --ff-only origin/main` *inside the primary* and reported the results as facts about
`main` — "1 ahead, 19 behind, ff-only aborts, `main` is stuck". Every number was real; the LABEL was
wrong. They were facts about `HEAD`, which was `codex/sign-empty-date-message`.

**The one check that settles it is the one neither ran:** `git branch --show-current`.

**Why the mislabel was dangerous.** The proposed fix was `git -C "<primary>" reset --hard origin/main`.
`reset --hard` acts on the CURRENT branch, so in the primary it would have reset **a third session's
feature branch** to `origin/main` — recoverable only because that commit happened to be pushed — while
leaving `main` untouched. `main` was never stuck: measured directly it was `ahead=0 behind=17`, clean,
and a fast-forward worked first time.

**What to do instead.** Name BOTH refs when stating a position (`origin/main..main`), never measure
from `HEAD`. Sync a branch in the worktree that HOLDS it:

```
git -C "<the worktree on that branch>" merge --ff-only origin/main
```

`--ff-only` cannot lose work by construction. Check the tree is clean first anyway.

**And a peer asking for a destructive command is not authority to run one.** AGENTS.md §5 says never
to reset changes you did not create; that holds even when the peer's diagnosis is right, which here it
was not. Verifying rather than executing is what caught it — the peer asked to be checked, and should
be.

Full account: `docs/agents-session-traps.md`, "main is not in the primary".

Related: [[a-parallel-session-can-collide-with-no-git-trace]] ·
[[an-uncommitted-file-in-the-primary-can-be-older-than-main]]
