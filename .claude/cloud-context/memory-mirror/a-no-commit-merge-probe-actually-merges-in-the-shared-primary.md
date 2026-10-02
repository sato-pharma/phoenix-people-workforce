---
name: a-no-commit-merge-probe-actually-merges-in-the-shared-primary
description: "`git merge --no-commit --no-ff` is NOT a dry run — it performs the merge and leaves MERGE_HEAD, so a \"would this overwrite anything?\" probe mutates the shared primary checkout that every parallel session edits (done 2026-10-02). The real pre-flight is read-only: git diff --name-only HEAD..origin/main plus git ls-files --other --exclude-standard. And never `merge --abort` a shared primary reflexively: first prove the staged name list is identical to HEAD..origin/main with zero unmerged paths, because abort discards anything else."
metadata:
  node_type: memory
  type: project
  originSessionId: 47e0759c-ce68-4b3d-9b7d-157208b1fa69
  modified: 2026-10-02T10:30:46.198Z
---

**What was run, believing it to be read-only**, before fast-forwarding the primary checkout on the
owner's instruction (2026-10-02):

```
git merge --ff-only --no-commit origin/main --no-ff
```

The intent was "tell me whether this merge would clobber the untracked file". **`--no-ff` wins over
`--ff-only` in that combination, and `--no-commit` does not mean "do not merge" — it means "merge,
stage the result, and stop before writing the commit".** So it merged 6 commits into the index and
working tree of `F:\Phoenix Workforce\phoenix-workforce` and left `.git/MERGE_HEAD` behind.

🔴 **That folder is the one every parallel session shares, and a session was provably live in it at
the time** (lock refreshed inside the minute). A half-merged index there is visible to that session's
own `git status`, and its next `git commit -a` would have committed my merge as its own work.

**The tell comes one command later, and it reads like a conflict:**

```
fatal: You have not concluded your merge (MERGE_HEAD exists).
Please, commit your changes before you merge.
```

🔴 **Git's own advice there is the trap.** "Commit your changes" would put a MERGE COMMIT on local
`main` in the primary — forbidden outright (`AGENTS.md` §2: never commit onto local `main` in the
primary checkout, where another session's reset destroys it, and the push is rejected by
`enforce_admins` anyway). The merge also wasn't a fast-forward any more, so it would have rewritten
the shape of `main` for everyone.

## Recovering it without destroying someone else's work

`git merge --abort` is the cure, and it is **not** automatically safe here: it discards every staged
change, including a parallel session's. **Prove the index holds nothing but commits already on
origin, first:**

```
git diff --name-only --diff-filter=U          # must be EMPTY — no conflicts
git diff --cached --name-only HEAD            # must equal, sorted, the next line
git diff --name-only HEAD origin/main
```

On 2026-10-02 both lists were the same 15 files and there were no conflicts, so the abort could only
undo my own probe — HEAD returned to `7f64cfe13` with a clean tree, the untracked `_ship-5085.txt`
survived, and `git merge --ff-only origin/main` then fast-forwarded cleanly to `579fd7efd` with no
merge commit. **Had anything else been staged, the right move was to stop and ask the owner**, not to
abort: there is no way to tell a third session's staged work from the merge's own.

## The read-only pre-flight that answers the same question

A fast-forward can only fail on an untracked file it would overwrite, which is two plumbing reads and
no mutation:

```
git diff --name-only HEAD..origin/main        # what is coming
git ls-files --other --exclude-standard       # what is untracked here
```

Intersect them. `git merge-tree` is the read-only merge simulator if a real merge result is needed.
🔴 **The general rule, which is the durable half: before running a git command as a PROBE in a shared
checkout, check whether its flags write anything.** `--dry-run` exists on `git clean`, `git push` and
`git rm`; `git merge` has no such flag, and the combination that looks like one is the one that
merges.

Related: [[main-is-not-the-primary-checkout]] (the primary is normally NOT on `main`, which is why a
pull there is unusual enough to reach for an unfamiliar probe) ·
[[a-merge-mid-session-orphans-your-next-push-silently]] ·
[[gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded]] (the sibling shape: a git command
whose scary output does not describe what actually happened).

🔴 **Reachability: this slug is NOT yet in the `AGENTS.md` §2.1 roster**, and `MEMORY.md` has 24 bytes
of budget left, so it is currently recallable only by description match. Add
`a-no-commit-merge-probe-actually-merges-in-the-shared-primary` (backticked) to the §2.1 roster on the
next PR that touches `AGENTS.md` — never as a one-line PR of its own, which is exactly the small PR
`bash-guard` C10 refuses.
