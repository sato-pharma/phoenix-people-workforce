---
name: deleted-branch-tips-live-in-refs-deleted-branches
description: "14 never-merged remote branches were deleted 2026-08-21; each tip was DELIBERATELY archived under refs/deleted-branches/* in the main checkout FIRST - a plain git branch -D archives NOTHING, so this is a manual step and never automatic, and nothing else points at them. A MERGED branch is the opposite case: its tip survives on origin as refs/pull/<n>/head, so deleting it locally loses nothing - and comparing refs/backups/* by NAME over-reports at-risk refs, ask whether the COMMIT is on origin"
metadata: 
  node_type: memory
  type: project
  originSessionId: ee8e1dd7-5943-412c-9063-b9a3827f3d74
  modified: 2026-08-22T13:15:56.305Z
---

On **2026-08-21** the owner had the remote branch list swept. 23 branches went, in three passes:
9 whose PR was merged, the closed-unmerged `codex/crm-brick-coverage-mobile-cards` (#2267), and
**14 that never had a PR at all**. The remote went 71 → 50.

**The last 14 each carried 1–2 commits that are NOT on `main`** — that is unmerged work with no PR
and, once the branch is gone, **no GitHub "Restore branch" button**, because that button only
exists on a PR. So before deleting, every tip was fetched into the **main checkout**
(`F:\Phoenix Workforce\phoenix-workforce`) as:

```
refs/deleted-branches/<original-branch-name>
```

All 14 commit objects were verified present after the deletion. **Nothing else references them** —
they are invisible to `git branch`, `git branch -a`, and every "list the branches" check. Only
`git for-each-ref refs/deleted-branches/` shows them.

To see what is there, or bring one back:

```
git for-each-ref --format='%(objectname:short) %(refname:short)' refs/deleted-branches/
git log --oneline origin/main..refs/deleted-branches/<name>
git checkout -b <name> refs/deleted-branches/<name>
```

The three most recent were last touched **2026-08-19**, two days before deletion, so they are the
likeliest to have been live work someone paused: `codex/marketing-case-file-ui` (8 files),
`codex/territory-area-index` (3 files), `codex/plans-portal-redesign` (1 file). The largest was
`wip/office-differentiation` (23 files, 2026-08-12), then `codex/isolated-workspace` (15 files).

**Why:** the owner asked for the sweep after being told these carried unique unmerged work, so the
deletion was his call — but a decision made in a cleanup pass should not be irreversible. These
refs are the recovery path, and they only survive as long as this checkout does. They are **not**
pushed anywhere; a fresh clone will not have them.

**How to apply:** never treat "the branch is gone from GitHub" as proof the work is gone — check
here first. And when sweeping branches in future, distinguish the three cases before acting:
PR-merged (safe, verify the merge commit is an ancestor of `main`), PR-closed-unmerged (someone
decided against it — keep), and no-PR-at-all (no evidence either way — preserve the tip before
deleting). `git branch --merged` answers none of these, because PRs here merge by squash.

## 2026-08-22 — the archive grew, and there is now a SECOND one

A local cleanup added to this and created a sibling. **Check both.**

`refs/deleted-branches/` is now **18**, not 14 — the four `rescue/*` branches were appended as
`rescue-chains-name-wrap`, `rescue-not-a-cv-badge`, `rescue-pharmacy-search-area`,
`rescue-rules-only-is-cv-null`. They were **never pushed**, so GitHub has no copy under those names
and `gh pr list --head` returns nothing for them — which is exactly why "no merged PR" did not mean
"unmerged". Their content had landed via #2273/#2274/#2280/#2281; two of them are byte-identical to
`main` and two hold **older** files that would regress it.

**`refs/deleted-stashes/` is new** and holds all **10** stashes, cleared the same day, named
`<index>-<branch>`. Same recovery commands, same caveat — local only, never pushed.

```
git for-each-ref refs/deleted-stashes/
git stash apply refs/deleted-stashes/<name>          # or: git diff <name>^1 <name>
```

A stash commit keeps its untracked files on the **third parent** (`<sha>^3`), so a file scan that
only diffs `^1..sha` under-reports it — that gap is why the pre-drop document scan checked both.

18 local branches were deleted in the same pass (12 with merged PRs, 3 with zero commits not already
on `main`, plus the four `rescue/*`), and 4 zero-file husks cleared.

Related: [[deleting-a-branch-does-not-remove-a-pushed-commit]] ·
[[reusing-a-squash-merged-branch-makes-a-conflicting-pr]] ·
[[admin-hr-cannot-be-recreated-hr-id-must-be-null]]

## 2026-08-23 — the count is 19, and the obvious check REPORTS ZERO

Re-verified tonight: **19** refs under `refs/deleted-branches/` (not 18 — `duplicate-consolidation-ci-fix-0a4da98a`
was added 2026-08-22) and **10** under `refs/deleted-stashes/`. All 29 files are present in
`.git/refs/`, and the commit objects still resolve.

**The trap: `git for-each-ref 'refs/deleted-*'` returns 0.** It is not an error, not a warning — a
clean, confident zero. This session ran exactly that, concluded the recovery path had been wiped,
and wrote "0 refs left" into `MEMORY.md` before catching it.

```
git for-each-ref 'refs/deleted-*'        # 0   <- WRONG, and silent about it
git for-each-ref 'refs/deleted-*/*'      # 16  <- still wrong; misses the 13 at depth 1
git for-each-ref refs/deleted-branches/  # 19  <- correct
git for-each-ref refs/deleted-stashes/   # 10  <- correct
```

A `*` in a for-each-ref pattern does not cross `/`, so `refs/deleted-*` matches only refs sitting
*directly* at that level and nothing nested. Since every one of these refs is nested at least one
level deep, the glob matches nothing at all. The `*/*` form is worse than useless: it returns a
plausible-looking 16 and silently drops the 13 that are one level deep.

**Why:** a check that under-reports to zero is far more dangerous here than one that errors. These
refs are the ONLY copy of 19 unmerged branch tips and 10 stashes — nothing is pushed — so a false
"they're gone" invites exactly the cleanup that would make it true.

**How to apply:** enumerate these with the **directory prefix**, never a glob, and never `refs/deleted-*`.
If a count of 0 comes back, check `ls .git/refs/deleted-branches/` before believing it. The same
caveat applies to any nested ref namespace in this repo (`refs/codex/`, `refs/pr/`, `refs/sessions/`).

## 2026-08-23 — how to decide whether a preserved tip can be retired

Worked through on the 19th tip above, `duplicate-consolidation-ci-fix-0a4da98a`. It is the
**no-PR-at-all** case: `gh pr list --head` returns nothing and the tip is not an ancestor of
`origin/main`. **Neither fact means the work was lost**, and neither answers the question.

The question is not *"was this branch merged"* — squash merges make that unanswerable, which is
why `git branch --merged` is always wrong here. It is **is the CONTENT on `main` today**:

```
git show --stat --format='' refs/deleted-branches/<name>     # what did it touch
git grep -n '<identifier it added>' origin/main -- <file>    # is that on main now
```

For this one the answer was yes. It added four `/api/territory-management/area-consolidation*`
entries to `src/lib/security/access-registry.ts`; all four are on `main` today (lines 716, 717,
721, 722, under the `guard: "domain-helper"` note at 713). It reached `main` under a different
branch name, so the tip is a duplicate — **there is no unregistered route**. That mattered enough
to check: an unregistered API route is a real access-control gap, not bookkeeping.

Left in place regardless. These refs cost nothing, and the point of writing this down is that the
next session should not have to redo the investigation to find out it was safe.

Related: [[a-role-probe-cannot-trust-the-http-status-code]] ·
[[git-ref-colon-path-is-mangled-by-msys-returns-empty]] ·
[[list-migrations-reports-ledger-not-reality]]

## 2026-08-23 — STOP PINNING THE COUNT. It went stale twice in one night.

The number in this file has now been wrong three times in about six hours: 18 → 19 (a tip nobody had
counted) → **20** (`deleted-branches/codex/organogram-whatsapp-gate-tests`, `5f9c1d55`, archived when
that worktree was retired after PR #2304 merged as `f412b792`). Stashes are still 10. Every ref
resolves; 0 dangling, checked individually rather than sampled.

**The count is not the fact, and writing it down manufactures a false alarm.** Every branch
retirement adds one, so any number recorded here is stale by the next retirement — and a reader who
trusts a stale low number concludes that tips went missing. That is precisely the panic this file
exists to prevent.

**The durable facts, none of which move:**
1. These refs are the **only copy** of unmerged branch tips and stashes. Nothing is pushed; there is
   no GitHub "Restore branch" button for them.
2. `git for-each-ref 'refs/deleted-*'` returns **0**, silently, with no error — `*` never crosses
   `/`. `'refs/deleted-*/*'` is also wrong (it drops the refs at depth 1). Only the full prefixes
   are right: `refs/deleted-branches/` and `refs/deleted-stashes/`.
3. The archive **grows**; it is append-only in practice.

**How to apply:** count it live when you need a number, with the full prefix, and never quote a
number from this file. The index line no longer carries one either.

**Why this matters beyond this file:** the same shape bit two sessions tonight from three
directions — a glob that reads 0, an MSYS `grep` that cannot match emoji and reads 0, and this
count. In all three the check was broken and returned a confident, plausible number. **A memory that
pins a live-changing quantity is a check that silently expires.** Record the invariant and the way to
measure it; leave the quantity to the measurement.

**Nothing populates this automatically — it was a one-off manual fetch, and still is.** Verified
2026-08-23 while deleting the merged `claude/agitated-pare-a6ce59`: `git branch -D` left the ref
count at **34 before and 34 after**, and `git grep -l deleted-branches -- .claude scripts` finds
**no hook and no script**. So there is no pre-delete capture anywhere in the repo. A session that
deletes a branch believing this archive will catch the tip is wrong — the safety net is a habit,
not a mechanism.

That deletion was safe for a different reason, which is the reusable test: the branch was
squash-merged (`gh pr list --head <branch> --state merged` named PR #2345 -> `f85184bf`), the
changed file was byte-identical to `origin/main`, and `git log --oneline <branch> --not --remotes`
counted **0**. Confirm all three before `-D`; the commit stays reachable by SHA locally until gc,
but that is not a backup. For an UNmerged branch, fetch the tip into `refs/deleted-branches/<name>`
by hand first, exactly as the 2026-08-21 sweep did.

**The repo-wide gate `git log --branches --not --remotes` FLIPS from 0 to non-zero the moment you
`git fetch --prune`, and the new number is mostly FALSE POSITIVES.** Measured 2026-08-23: it read
**0** before the prune and **2** immediately after, with no commit created in between. GitHub
deletes the remote branch on merge (`delete_branch_on_merge` is on), but the local
`refs/remotes/origin/<branch>` survives until pruned — and while it survives it still makes that
branch's tip "reachable from a remote", so the gate stays quiet. Prune, and every local branch whose
PR was **squash**-merged suddenly counts as unbacked, because a squash puts the content on `main`
under a *different* SHA and the old tip is genuinely on no remote any more.

Both flagged commits (`fa877071` #2344, `3f3cd32b` #2343) were merged and their files identical to
`origin/main`. Nothing was at risk. **So do not read a non-zero count after a prune as lost work,
and do not read a zero count before one as proof of safety.** Separate the two cases:

```
gh pr list --head <branch> --state merged          # squash-aware; the real question
git diff origin/main:<file> <branch>:<file>        # per-file, for anything the PR check cannot answer
```

A branch that is merged is safe however the count reads. A branch with **no merged PR** and a
non-zero count is the one to stop for — that is the case [[self-removing-a-worktree-mutes-its-own-session-end-guard]]
tells you to check before any worktree removal, and it is the case the archive above exists for.

## 2026-08-23 — `git branch -D` does NOT archive. The archive is MANUAL, and that changes when deleting is safe.

Deleted four merged branches and watched the count: **44 before, 44 after.** Nothing was archived.

- `core.hooksPath` is the default `.git/hooks`; there is **no** `.githooks` directory.
- `git grep -l "refs/deleted-"` across `scripts/` and `.claude/` returns **nothing** — no repo script
  or hook writes these refs.
- Yet the newest entries are dated **today**. So they are written by hand, ad hoc, by whichever session
  thought to do it: `git update-ref refs/deleted-branches/<name> <sha>` *before* `git branch -D`.

**Why this matters more than it looks.** The hook line for this memory reads *"deleted tips + stashes:
`refs/deleted-*` — the ONLY copy"*, which invites the reading *"deletion is safe here, tips get
archived."* **It does not mean that.** It describes 44 refs somebody deliberately saved. Delete an
**unmerged** branch without archiving first and the tip is reachable only through the reflog until gc
takes it — there is no safety net running in the background.

**How to apply.**
- **Before `git branch -D`, establish which case you are in.** If `gh pr list --head <branch> --state
  merged` names a PR *and* the content is verified on `main`, the branch is redundant and deleting it
  loses nothing — no archive needed, and adding one is noise. **Anything else: archive first.**
  ```
  git update-ref refs/deleted-branches/<name> $(git rev-parse <branch>)
  ```
- **Record the tip SHA in your reply before deleting, whatever the case.** Doing that here is the only
  reason the four tips could be shown to still resolve (`git cat-file -t` → `commit`) after the archive
  turned out not to have caught them. Costs one line; converts "probably fine" into proof.
- **A squash-merged branch always reports commits "not on main" — that is not unpushed work.** All four
  showed 1–2, because a squash merge is never an ancestor. Judge by the merged PR and the content on
  `main`, never by `rev-list --count origin/main..<branch>`.

## 2026-08-26 — there IS a second archive, and it is ON ORIGIN. Plus a date field that lies.

Two things this file did not have, found while auditing a `git remote prune origin` that cleared 41
stale refs.

**1. `refs/backups/*` exists on ORIGIN — 5 refs, pushed, survives a fresh clone.**

Everything above says these tips are "not pushed anywhere" and "a fresh clone will not have them."
That is true of `refs/deleted-*` and false as a general statement, which is the dangerous half:
a session hunting a lost tip that reads only this file will never look at the remote.

```
git ls-remote origin 'refs/backups/*'          # 5 here on 2026-08-26
git fetch origin 'refs/backups/*:refs/backups/*'
git branch <name> refs/backups/<name>
```

Written by `scripts/prune-stale-branches.ps1`, which does
`git push --force origin "refs/remotes/origin/<name>:refs/backups/<name>"` before deleting a remote
branch. So the two namespaces are unrelated and have opposite properties — **local/manual/never
pushed** vs **remote/scripted/permanent**. Check BOTH before concluding a tip is gone. The remote one
is the only one that survives losing this laptop.

**2. `%(creatordate)` on these refs returns the COMMIT's date, not when the ref was written.**

Sorting the archive by it to ask "when did capture last happen" produces a confident, plausible,
wrong answer — the same failure family as the `refs/deleted-*` glob that reads 0. The real signal is
the loose ref file's mtime:

```
git for-each-ref refs/deleted-branches/ --sort=-creatordate    # WRONG: commit dates
find .git/refs/deleted-branches -type f -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort -r
```

All 43 branch refs + 10 stash refs are loose; 0 are packed, so the mtime is reliable. Measured this
way the last hand-capture was **2026-08-24 01:42**.

**Why:** that 2.5-day gap looks like a mechanism that stopped, and it is not one — it is a habit
nobody exercised, exactly as the sections above say. Do not read a stale mtime as a broken tool;
there is no tool. Equally, do not read the gap as "deletes are being archived fine" — local branches
from merged PRs simply linger here rather than being deleted, so the archive is rarely exercised.

**How to apply:** when a tip really is missing, check `git ls-remote origin 'refs/backups/*'` before
declaring it lost, and never date this archive by `creatordate`.

## 2026-08-27 — measured a THIRD time (96 → 96), and `AGENTS.md` was the thing carrying the bad claim

Deleted 6 verified-merged `rescue/*` branches and watched the count: **96 before, 96 after**, newest
archived entry still `12:23`, hours older than the deletions. Same result as the 44 → 44 measurement
above. **This file was already right** — the manual-archive finding has been recorded here since
2026-08-23 — so nothing here needed correcting.

**What was wrong was the summary in `AGENTS.md` §2.1**, which read *"Deleted branch tips and stashes
live under `refs/deleted-*` and are the ONLY copy"*. A session reads §2.1 automatically (it loads in
full via `CLAUDE.md`'s `@AGENTS.md`) and reaches this file only if it follows the pointer — so the
misleading half was the half that always gets read, and the correct half was opt-in. Fixed in
**PR #2467**, which now says the archive is manual, states how to write one deliberately, and points
at `refs/backups/*`.

**The reusable lesson: when a memory and its `AGENTS.md` hook disagree, the hook is the dangerous
one.** Correcting the memory file alone would have left every future session reading the wrong
sentence and never opening this one. When a sweep finds a stale claim, check whether an auto-loaded
summary of it exists, and fix that first.

Verified live in the same pass, rather than trusted from the section above: `git ls-remote origin
'refs/backups/*'` returns **5** refs and `scripts/prune-stale-branches.ps1` is present with 8
`refs/backups` mentions. All 6 deleted tips still resolve as objects (`6b1ad35f`, `76ecf695`,
`6948f3bf`, `2aae8a77`, `3e9a3bc0`, `f4c559a3`) and each was patch-id identical to its squash commit
on `main` before deletion — the gate that made not archiving them correct rather than lucky.

## 2026-09-04 — the opposite case: a MERGED tip is already backed up, as `refs/pull/<n>/head`

Everything above is about tips that were **never merged and never pushed**, where the local archive
ref is genuinely the only copy. **A merged branch is the reverse, and confusing the two wastes a
push or blocks a safe delete.**

GitHub's `delete_branch_on_merge` removes `refs/heads/<branch>` but **keeps the pull request's
head ref forever**. So after a squash merge:

| | |
| --- | --- |
| `refs/heads/codex/<branch>` on origin | **gone** |
| `refs/pull/<n>/head` on origin | **still the original tip** |
| the squashed content | in `main` |

Verified 2026-09-04 on two branches merged that evening — `codex/brick-geo-readiness-count`
(`a3664580`, PR #3093) and `codex/agents-rls-figure` (`0401822`, PR #3094): both local branches had
vanished, and `git ls-remote origin refs/pull/<n>/head` returned each original SHA exactly.

## 🔴 The trap: comparing `refs/backups/*` by NAME over-reported at-risk refs 15 to 1

`repo:doctor` reported **1** local archive ref with no copy on origin. A hand check comparing
`for-each-ref refs/backups/*` against `ls-remote origin 'refs/backups/*'` as `SHA + refname` pairs
reported **15** — and the 14 extra were about to be handed to the owner as commits at risk of being
lost with the laptop.

**They were all safe.** `refs/backups/cv-popup` (`ad604008`) is on origin as
**`refs/pull/2913/head`** — the commit is on GitHub under a ref with a different name.

**Ask whether the COMMIT is on origin under ANY ref, never whether its NAME is:**

```bash
git ls-remote origin | grep "^<sha>"     # empty = disk only; anything = backed up
```

Same shape as [[address-matching-beats-paid-ai-and-geocoding-hurts]] and the brick-orphan count in
[[brick-coordinates-are-geocoded-guesses]]: **the denominator, or the join, is the whole answer.**
A tool that already asks the right question (`repo:doctor`) beat a hand-rolled check that asked a
narrower one — when they disagree, find out why before reporting either.
