---
name: a-rollup-can-carry-your-pr-seconds-before-you-merge-it
description: "A roll-up another session built can merge SECONDS before you merge its member, and the member still reads OPEN/CLEAN with both required checks green because GitHub lags — so the merge goes through and produces a content-EMPTY commit on `main`, paying a full `main` CI run and a duplicate production deploy; test the FILES against `origin/main` immediately before pressing, never `--is-ancestor` (a roll-up squashes, so that is always false)"
metadata:
  node_type: memory
  type: project
---

Measured on my own merge, 2026-10-09/10. PR 5723 (Railway deploy config, 5 files) and PR 5722
(mapping guard, 3 files) were both green. I ran `node scripts/rollup-prs.mjs` read-only, saw **no
open `codex/rollup-*` PR**, could not get 5722's head confirmed final by any session, and decided to
hand 5723 on its own — a defensible call at the time. While the owner was reading that, **another
session built the roll-up and it merged.**

```
5724 (roll-up)   merged 2026-10-09T22:11:06Z   b0a4de591   tree 2e26b1f3a2a1…
5723 (my member) merged 2026-10-09T22:11:47Z   00e2cdbc0   tree 2e26b1f3a2a1…
                                               41 seconds apart, IDENTICAL trees
```

`git diff --stat b0a4de591 00e2cdbc0` is **empty**. My merge changed nothing: it added a second
commit to `main` carrying the same tree, which cost a full `main` CI run and a second production
deploy of byte-identical code. No data loss, no broken code — pure waste.

**Why the gate I ran did not catch it.** Immediately before merging I re-read the required checks and
the merge state, and got `#5723 OPEN/CLEAN | validate=success checks=success`. That reading was
correct and useless: GitHub had not yet reconciled the fact that the content was already on `main`,
and it lags by tens of seconds. **A member's own green/CLEAN status is not evidence that it still
needs merging.**

**How to apply:**

- Immediately before `gh pr merge`, fetch and test **the files**: for every path the PR changes,
  `git diff --quiet origin/main <head> -- <path>`. All identical → the PR is **CARRIED**, so close it
  (`node scripts/rollup-prs.mjs --settle`) and never merge it. This is the one test that works.
- 🔴 **Do NOT use `git merge-base --is-ancestor <head> origin/main`** — a roll-up carries members by
  squash, so the member's head is NOT an ancestor even when every byte of it is on `main`. It
  answered `no` here while the trees were identical. Compare content or trees, never ancestry.
- `bash-guard.mjs` **C13** refuses `gh pr merge` of a member listed in an **open** roll-up, and
  cannot fire once the roll-up has merged — which is exactly the window this lands in. The hook is
  not cover for this case.
- Re-run `rollup-prs.mjs` (or check for an open/recently-merged `codex/rollup-*`) **in the same turn
  as the merge**, not fifteen minutes earlier. A read that a roll-up does not exist expires in
  seconds when other sessions are live.
- The existing rule is "a roll-up must be merged BEFORE its members, and if they land first, CLOSE
  it". This is the mirror: **when the roll-up lands first, the members are closed, not merged** — and
  the one who has to notice is whoever is holding the member.

Related: [[a-docker-hub-429-silently-stopped-four-production-deploys]].
