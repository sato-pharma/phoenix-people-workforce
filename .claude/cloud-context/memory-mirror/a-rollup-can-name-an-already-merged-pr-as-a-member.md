---
name: a-rollup-can-name-an-already-merged-pr-as-a-member
description: "`rollup-prs.mjs` lists as a member any PR that was open when it RAN, so a roll-up built in the same minute you merge something names that merged PR as a member and was cut from a main that did not have it yet — merging it then reverts that work. Before merging a roll-up, diff every file of each already-merged member between origin/main and the roll-up head and require byte-identity; `mergeStateStatus: CLEAN` does not see this, because a clean merge of an older blob is exactly how the revert happens."
metadata:
  node_type: memory
  type: feedback
---

Measured 2026-10-06. PR #5371 merged at 08:04:38 UTC; roll-up #5372 was created at 08:04:45 UTC —
seven seconds later — and its body named **#5371** among its members, because `rollup-prs.mjs` had
read the open-PR list moments before. `git merge-base --is-ancestor <5371's merge> <roll-up head>`
answered **no**: the roll-up was cut from a `main` that did not yet contain it.

**Why:** a roll-up is a branch built from the member branches on top of whatever `main` was at the
time. If a member lands on `main` by itself in that window, the roll-up still carries that member's
own blobs — fine when they are identical, a silent **revert** when `main` has moved on past them.
`mergeStateStatus` reads `CLEAN` either way: cleanly merging an older blob over a newer one is not a
conflict, it is the loss.

**How to apply:** before merging any roll-up, take each member the roll-up names, and for every file
that member changed compare `origin/main:<file>` against `<roll-up head>:<file>` by blob sha. Require
**byte-identity on every one**; a single mismatch means the roll-up would carry an older copy, and the
merge stops there. On 2026-10-06 all 11 of #5371's files were identical, so the merge was safe — but
that was the check answering, not luck, and the roll-up simply replaced one fewer merge than its body
claimed. Afterwards run `rollup-prs.mjs --settle`, which closed #5369 and #5370 because their files
were already on `main` — a member lands CLOSED, never merged, so byte-identity is the only test that
holds for it. Related: [[the-small-pr-merge-guard-and-the-classifier-deadlock]],
[[a-reused-branch-name-finds-the-old-merged-pr]].
