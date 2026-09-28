---
name: deleted-branch-tips-live-in-refs-deleted-branches
description: "Unmerged branch tips are archived MANUALLY under refs/deleted-branches/* (and stashes under refs/deleted-stashes/*) in the main checkout — `git branch -D` archives NOTHING, there is no hook or script, so it is a habit not a mechanism. These are LOCAL and never pushed. refs/backups/* is the OPPOSITE — on origin, scripted, survives a clone. A MERGED tip needs no archive (it lives on origin as refs/pull/<n>/head). Never pin a count; `git for-each-ref 'refs/deleted-*'` reads 0 silently; ask whether the COMMIT is on origin, never whether its NAME is."
metadata: 
  node_type: memory
  type: project
  originSessionId: ee8e1dd7-5943-412c-9063-b9a3827f3d74
  modified: 2026-09-26T03:20:37.149Z
---

Unmerged branch tips with no PR carry commits that are on no remote and have **no GitHub "Restore branch"
button** (that button exists only on a PR). Before deleting such a branch, its tip is fetched into the main
checkout as `refs/deleted-branches/<original-branch-name>` (stashes go to `refs/deleted-stashes/<index>-<branch>`).
To see or recover:

```
git for-each-ref refs/deleted-branches/                         # NOT a glob — see the trap below
git log --oneline origin/main..refs/deleted-branches/<name>
git checkout -b <name> refs/deleted-branches/<name>
git stash apply refs/deleted-stashes/<name>                     # untracked files hang off <sha>^3
```

## Two archives, opposite properties — check BOTH before calling a tip lost

- **`refs/deleted-branches/*` + `refs/deleted-stashes/*` — LOCAL, MANUAL, NEVER PUSHED.** They are the ONLY
  copy of what they hold; a fresh clone will not have them, and losing this laptop loses them. 🔴 **Nothing
  populates them automatically.** `git branch -D` archives NOTHING (verified: the count is unchanged before
  and after a delete), there is no hook (`core.hooksPath` is the default `.git/hooks`, no `.githooks`) and no
  script writes these refs. The archive is a deliberate `git update-ref refs/deleted-branches/<name> <sha>`
  run by hand *before* the delete — a habit, not a safety net. So a session that deletes an unmerged branch
  trusting this archive to catch the tip is WRONG; the tip is then reachable only via the reflog until gc.
- **`refs/backups/*` — on ORIGIN, PUSHED, scripted, survives a clone.** Written by
  `scripts/prune-stale-branches.ps1`, which force-pushes `refs/remotes/origin/<name>:refs/backups/<name>`
  before deleting a remote branch. This is the only copy that outlives the laptop.
  ```
  git ls-remote origin 'refs/backups/*'
  git fetch origin 'refs/backups/*:refs/backups/*'
  ```

Everything that says these tips are "not pushed anywhere" is true only of `refs/deleted-*`; a session hunting
a lost tip that reads only that half never looks at the remote. Check both namespaces.

## Deciding whether a delete is safe — the three cases

`git branch --merged` answers NONE of them, because PRs here merge by SQUASH so a merged branch is never an
ancestor of `main`. Establish which case you are in first:

- **PR-merged** (`gh pr list --head <branch> --state merged` names it) → safe, no archive needed. The tip
  survives on origin as **`refs/pull/<n>/head` forever**, even after `delete_branch_on_merge` removes
  `refs/heads/<branch>` — [[deleting-a-branch-does-not-remove-a-pushed-commit]].
- **PR-closed-unmerged** → someone decided against it; keep.
- **No PR at all** → no evidence either way; **archive the tip first** with `git update-ref`.

🔴 **The real question is never "was it merged" (unanswerable under squash) but "is the CONTENT on `main`
today"** — `git diff origin/main:<file> <branch>:<file>` (watch the MSYS ref:path trap,
[[git-ref-colon-path-is-mangled-by-msys-returns-empty]]) or `git grep` the identifier it added.
`git rev-list --count origin/main..<branch>` always shows 1–2 for a squash-merged branch; that is NOT
unpushed work ([[reusing-a-squash-merged-branch-makes-a-conflicting-pr]]). Record the tip SHA in your reply
before deleting whatever the case — one line, and it converts "probably fine" into proof.

## Silent-zero and stale-count traps

- 🔴 **`git for-each-ref 'refs/deleted-*'` returns 0 — silently, no error** — because `*` never crosses `/`,
  and every one of these refs is nested. `'refs/deleted-*/*'` is also wrong (it drops the refs one level
  deep). Only the full directory prefix works: `refs/deleted-branches/`, `refs/deleted-stashes/`. If a count
  of 0 comes back, `ls .git/refs/deleted-branches/` before believing it. Same caveat for any nested ref
  namespace (`refs/codex/`, `refs/pr/`, `refs/backups/`). A check that under-reports to zero here invites the
  cleanup that would make it true.
- 🔴 **NEVER PIN A COUNT.** The number in this file went stale three times in one night; every branch
  retirement adds one, so any recorded number is stale by the next retirement and a reader who trusts a stale
  low number concludes tips went missing — the exact panic this file exists to prevent. Record the invariant
  and the way to measure it; count it live with the full prefix when you need a number. **A memory that pins
  a live-changing quantity is a check that silently expires.**
- 🔴 **`%(creatordate)` on these refs returns the COMMIT's date, not when the ref was written** — sorting by
  it to ask "when did capture last happen" gives a confident wrong answer. Use the loose ref file's mtime
  (`find .git/refs/deleted-branches -type f -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort -r`); all refs are
  loose, 0 packed. And a stale mtime is not a broken tool — there is no tool; it is a habit nobody exercised.

## `git log --branches --not --remotes` flips false-positive on prune

🔴 **This gate flips 0 → non-zero the moment you `git fetch --prune`, and the new number is mostly FALSE
POSITIVES.** The local `refs/remotes/origin/<branch>` survives until pruned and keeps a squash-merged tip
"reachable from a remote"; prune, and every local branch whose PR was squash-merged suddenly counts as
unbacked (a squash puts the content on `main` under a different SHA, so the old tip is genuinely on no remote
any more). Do not read a non-zero post-prune count as lost work, nor a zero pre-prune count as safety. The
one case to stop for is **no merged PR AND a non-zero count** — the case
[[self-removing-a-worktree-mutes-its-own-session-end-guard]] flags before any worktree removal.

## 🔴 Ask whether the COMMIT is on origin, never whether its NAME is

Comparing `refs/backups/*` to origin by NAME over-reported at-risk refs 15-to-1 against `repo:doctor`'s 1 —
because a commit can be on origin under a DIFFERENT ref name (e.g. `refs/pull/<n>/head`).
```bash
git ls-remote origin | grep "^<sha>"     # empty = disk only; anything = backed up
```
Same shape as [[address-matching-beats-paid-ai-and-geocoding-hurts]] and the orphan count in
[[brick-coordinates-are-geocoded-guesses]]: **the denominator, or the join, is the whole answer.** When a
tool that asks the right question and a hand-rolled narrower check disagree, find out why before reporting
either.

## The meta-lesson: fix the auto-loaded hook before the memory

When a memory and its `AGENTS.md` hook disagree, **the hook is the dangerous one** — §2.1 loads in full on
every request (via `CLAUDE.md`'s `@AGENTS.md`) and this file is reached only by following the pointer, so a
misleading one-line summary is the half that always gets read while the correction stays opt-in. An
`AGENTS.md` §2.1 line implying `refs/deleted-*` auto-captures on delete was the actual bug; the memory was
already right. When a sweep finds a stale claim, check whether an auto-loaded summary of it exists and fix
that first.
