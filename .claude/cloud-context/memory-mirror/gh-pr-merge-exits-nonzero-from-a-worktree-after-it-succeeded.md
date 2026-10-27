---
name: gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded
description: "From a secondary worktree, `gh pr merge --delete-branch` prints \"fatal: 'main' is already used by worktree\" and exits non-zero AFTER the remote merge already succeeded — read the PR state, never retry the merge. And `--match-head-commit` takes the FULL 40-char headRefOid read from gh: a sha reconstructed from a 9-char short form is a fabricated value inside the one guard that exists to stop you merging an unverified commit (done 2026-10-02 on #5105)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cf70abf-2f97-4d4c-9b96-c0e3929ca595
  modified: 2026-10-02T09:35:22.796Z
---

Every session here works in a `_wt-*` worktree while `main` stays checked out in the primary
checkout, so **`gh pr merge --squash --delete-branch` always exits non-zero** with:

```
failed to run git: fatal: 'main' is already used by worktree at 'F:/Phoenix Workforce/phoenix-workforce'
```

**The merge still happened.** `gh` merges on the remote first, then tries to switch the LOCAL
checkout to the base branch and delete the local branch — and only that last, purely cosmetic step
fails. Confirmed 2026-09-03 on PR #2998: the command "failed", yet the PR was `MERGED` at
04:18:15 UTC as `9f31ac376` with the remote branch already deleted.

**Why:** the error text names `main` and says `fatal:`, which reads exactly like a merge that did
not happen. Retrying gets a "not mergeable" error on an already-merged PR, which reads like a
second, worse failure — and the tempting "fix" (checking `main` out here, or re-merging) is real
damage in response to a no-op.

**How to apply:** treat a non-zero exit from `gh pr merge` in a worktree as UNKNOWN, not failed.
Settle it with the PR itself before doing anything else:

```
gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state:.state,mergedAt:.mergedAt,sha:.mergeCommit.oid}'
```

`state: MERGED` means done — the only leftover is the local branch, which `git branch -D <branch>`
clears from the worktree. Note `gh pr view` has **no `merged` JSON field** (it is `state`); asking
for one errors out and lists the valid fields.

**A cleaner path that avoided the error entirely:** run the merge from a NON-git directory (the
session scratchpad), with `--repo it-gawish-hr/phoenix-people-workforce`, no `--delete-branch`
(`delete_branch_on_merge` deletes the remote branch anyway), and `--match-head-commit <CI-green sha>`
so it can only merge the commit that passed. `gh` then has no local checkout to touch and exits 0.
Confirmed 2026-09-16 on PR #3880 (exit 0, then `state: MERGED`). Still read the PR state afterwards.

🔴 **AND `--match-head-commit` TAKES THE FULL 40-CHARACTER `headRefOid`, READ FROM `gh` — NEVER A SHA
RECONSTRUCTED FROM THE 9-CHARACTER SHORT FORM.** Done 2026-10-02 on #5105: a status line had printed
`1e7c87882`, and the merge went out carrying `1e7c878827e4b2b9a5e67e6ca32fcbb6e9bf9cbd` — the first
nine characters real, the remaining thirty-one invented. The real head was
`1e7c87882910e65549a174c75635bd6d742c2a29`.

**Why it is worth a line of its own even though it cost nothing that time.** The failure direction is
safe — GitHub compares the value and refuses a mismatch, and on #5105 the PR had already been merged
by its own session so `gh` short-circuited with `! Pull request … was already merged`. But the whole
point of the flag is that the commit being merged is the commit whose checks you read; feeding it a
value you did not read turns a verification into a coin toss that usually lands on "refused" and
teaches you nothing when it does. **Read it and pass it verbatim:**

```
gh pr view <n> --json headRefOid --jq '.headRefOid'
```

Same shape as the fabrication traps elsewhere in this memory set: a precise-looking value that was
never measured is more dangerous than an obviously missing one, because nothing about it reads as a
guess. Related: [[the-small-pr-merge-guard-and-the-classifier-deadlock]], which now carries C13 —
the other clause that can refuse a `gh pr merge` here.

✅ **RESOLVED 2026-10-02 — that sibling's slug is now in the `AGENTS.md` §2.1 roster on `main`, so it
is reachable and this note is history, not a task.** For a few hours it was reachable from neither
`AGENTS.md` nor `MEMORY.md` and was carried only by the `[[link]]` above: a session hit C10 or C13
and had no recall of why either guard exists. 🔴 **The durable half is how that happens at all** —
`scripts/memory-index-reachability.mjs` matches the BACKTICKED slug in `AGENTS.md` and nothing else,
so a memory can be written, linked from prose, and still be invisible to recall. When you add one,
add the backticked slug to the §2.1 roster in the same change, and never as a one-line PR of its own
(that is exactly the small PR C10 refuses).
