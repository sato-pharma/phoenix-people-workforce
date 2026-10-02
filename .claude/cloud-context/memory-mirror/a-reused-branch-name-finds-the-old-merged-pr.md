---
name: a-reused-branch-name-finds-the-old-merged-pr
description: "`gh pr list --head <branch> --state merged` answers 'did ANY PR ever merge under this NAME', not 'did THIS work land'. A branch name reused after an earlier PR merged returns the OLD PR, so `new-session.mjs --remove` printed 'PR #3734 merged them — squash residue, not stranded work' for a branch whose own PR (#5089) was still OPEN. Gate a branch deletion on the PR's NUMBER and on the CONTENT being byte-identical on main, never on the branch name."
metadata:
  node_type: memory
  type: project
  originSessionId: 73e57dfd-59e9-4e08-8d24-cfbcccf853cf
  modified: 2026-10-01T22:35:20.799Z
---

🔴 **THE SQUASH-AWARE MERGED-BRANCH CHECK IS A QUESTION ABOUT A NAME, AND A REUSED NAME ANSWERS IT
FOR THE WRONG PR.** AGENTS.md §2 tells every session to ask `gh pr list --head <branch> --state
merged` instead of `git branch --merged`, because a squash merge is never an ancestor of `main`.
That is right, and it is incomplete: the query returns every merged PR that ever carried that head
**name**, and nothing in the answer says it is the PR for the work now on the branch.

**Measured 2026-10-02.** `node scripts/new-session.mjs --remove agents-footprint` printed:

```
commits vs main   present, but PR #3734 merged them — squash residue, not stranded work
```

The branch `codex/agents-footprint` had been used on **2026-09-12** by #3734 ("docs(agents): condense
AGENTS.md to its hooks"), which merged. Tonight's work reused the name, and **#5089 was still OPEN** —
so the reassurance was real, checkable, and about a different change. Taking it and deleting the
branch would have made GitHub close #5089 and thrown away the footprint relocation plus two map rows.

**Where the mechanism lives.** `scripts/new-session.mjs` runs `gh pr list --head <branch> --state
merged --json number --jq '.[0].number'`: it takes the first merged PR for the name and never
compares that PR's head to the branch tip, nor asks whether an OPEN PR exists for the same head. Once
#5089 itself merged the same query returned both `#5089` and `#3734`, so the answer also changes
shape as the work lands — which is why it looks fine when re-run afterwards.

**The tests that cannot be fooled, in the order to use them:**

1. **Ask for the PR by NUMBER**, from the session that opened it — `gh pr view <n> --json state` —
   never by branch name.
2. **Content, not state.** Every file the branch changed against its merge base must be
   byte-identical on `origin/main`: `git diff --name-only $(git merge-base origin/main <branch>)
   <branch>` then `git diff --quiet origin/main <branch> -- <file>` per file. Content is the only
   test that also holds for a PR that landed **closed**, because a roll-up carries its members
   as CLOSED and `delete_branch_on_merge` never fires for them.
3. **Check for an OPEN PR on the same head** before any deletion:
   `gh pr list --head <branch> --state open`. An open PR on the name means the work is not landed,
   whatever an old merged PR says.

**What this does NOT license.** It does not mean the removal gate is wrong to refuse or to
reassure in general — on a fresh name it is exactly right. It means the reassurance is only as
specific as the name, so on any branch whose name could have been used before (`codex/<task>` for a
recurring task such as a footprint, a trim or a sweep) it must be checked against the number.

**Not fixed in the script.** Making `new-session.mjs` compare the merged PR's `headRefOid` to the
branch tip, or refuse while an open PR carries the head, is a real change to a script that gates
deletion of work. It wants its own PR, fixtures and a break-verification, and was deliberately not
bolted onto a docs change.

Related: [[git-branch-d-is-not-a-safety-gate-after-a-squash-merge]] ·
[[a-squash-merge-makes-a-stacked-branch-rebuild-not-merge]] ·
[[gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded]]
