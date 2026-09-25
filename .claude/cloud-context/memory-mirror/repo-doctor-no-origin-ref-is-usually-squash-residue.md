---
name: repo-doctor-no-origin-ref-is-usually-squash-residue
description: "repo-doctor's \"N commit(s) on NO origin ref\" on a MERGED worktree is normally just squash residue, not lost work — prove it by comparing blobs against the squash commit"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8031b3ca-9a44-46e9-aef8-a95699827cf6
  modified: 2026-08-28T10:58:54.719Z
---

`pnpm run repo:doctor` prints, for retirable worktrees:

> `-- N commit(s) on NO origin ref, review before removing`
> `# ^^ STOP — N commit(s) exist on NO origin ref. That line strands them as dangling objects.`

**On a branch whose PR already merged, this is almost always the normal post-squash state, not
data loss.** PRs here merge by squash, so the original commits are never ancestors of `origin/main`,
and `delete_branch_on_merge` removes the remote branch — so the originals legitimately sit on no
origin ref while their *content* is safely on `main`. The warning is about the commit **objects**
becoming unreachable, not about the **work**.

`git cherry origin/main <branch>` does NOT settle it ALONE — for a MULTI-commit branch it marks
every commit `+` ("not upstream"), because the squashed patch never matches any individual patch.
Re-measured 2026-08-24 on a purpose-built three-commit fixture: all three came back `+` while the
work sat safely on main. (For a SINGLE-commit branch it does mark `-` correctly, which is why this
looks like it works until the day it does not.) See [[merged-branch-checks-must-be-squash-aware]].

**FIXED 2026-08-24 — repo-doctor no longer emits this false alarm.** `scripts/repo-doctor.mjs` now
asks about CONTENT rather than reachability, in `scripts/repo-doctor-unpushed.mjs`, pinned by
`tests/repo-doctor-unpushed-commits.test.ts`. It pairs the two comparisons because each alone has a
hole: the branch's CUMULATIVE diff from its merge base against each upstream commit's patch-id
(this is what catches a multi-commit squash), plus `git cherry` for anything cherry-picked or
rebased on its own. It walks the LONGEST prefix down, so a worktree whose PR merged and which then
took on new work blames only the new commits — measured 1, not 4. The doctor still runs in ~7s,
because candidates are rejected on changed-file-set before any patch-id is computed.

**So a fresh doctor run no longer needs the blob comparison below** — but keep it for reading an
OLD report, an older checkout, or any other tool making the same claim. The trigger for this fix
was believing such a STOP on PR #2364 and telling the owner to have the commit pushed: tip
`b4331638` and squash `6209cf40` shared patch-id `71422830…`, so there was nothing to rescue, and
pushing a squash-merged branch is itself the conflicting-PR trap
[[reusing-a-squash-merged-branch-makes-a-conflicting-pr]].

**RECURRED 2026-08-28, with repo-doctor never involved — a HAND-ROLLED audit regenerates this bug
exactly.** A worktree sweep checked `git ls-remote --heads origin <branch>` (0 refs) plus
`git cherry` (all `+`) and declared 8 commits across two merged branches "stranded, local-only",
then **broadcast `git push -u origin <branch>` to all 10 live sessions.** Both were merged:
`codex/hr-phase3-boundaries` = squash `c6eeb347` (#2554) and `codex/design-tokens-phase6` = squash
`eccf0920` (#2561), cumulative patch-ids identical. **Three peer sessions independently ran the
patch-id test and refused to comply**, which is the only reason this did not become three
conflicting PRs — and a conflicted PR runs no CI at all. So the fix recorded above protects the
DOCTOR's output, not the reasoning: any session re-deriving "is this backed up" by hand walks
straight back into it. **Call `scripts/repo-doctor-unpushed.mjs` instead of rebuilding the check** —
it already implements exactly this comparison.

**A THIRD trap made the first two look corroborated: comparing a UTC timestamp against Cairo ones.**
`gh pr view --json mergedAt` returns **UTC** (`09:51:22Z`); `git log --date=format:'%H:%M'` prints
**local Cairo** (`12:44`). Read together, six commits appeared to be written *three hours after*
their own merge — which is impossible for squash residue and therefore read as proof the work was
new. `09:51Z` **is** `12:51` Cairo: the commits predated the merge by seven minutes. Never compare
the two without converting; AGENTS.md §4's "report in Cairo, never raw UTC" is about presentation,
but mixing them inside a CHECK manufactures a false signal that survives review. See
[[a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal]].

**The decisive test** — compare blobs against the squash commit:

```bash
git log origin/main --grep="#<PR>" --oneline -3      # find the squash commit
git rev-parse "<branch>:<path>"                       # per file
git rev-parse "<squashSHA>:<path>"                    # identical hash => content preserved
```

Worked example 2026-08-14, `codex/reduce-email-notifications` (PR #2088, squash `9210bb41`):
8 commits on no origin ref, **13/13 files byte-identical** to the squash commit, and the branch tip
was committed 03:27:57Z — nine minutes *before* the 03:36:03Z merge. Nothing was at risk. A
`git branch rescue/<name> <tip>` ref is still cheap and preserves the granular history, but treat it
as precautionary, not urgent.

**The real risk in that same doctor line is the OTHER half — `N uncommitted file(s)`.** Those are
on no ref at all and vanish with the worktree. In the same case the worktree held two modified
files plus two UNTRACKED ones (a whole new page + component) existing nowhere else. Never commit or
stash another live session's in-flight edits; take a byte copy outside the repo instead
(`Copy-Item`, then `Get-FileHash` both sides to prove it), which touches none of their git state.

**When the blobs DIFFER, that is not proof of loss either — a later merged PR may have moved the
files on.** 2026-08-23, `codex/marketing-complete-reused-venue-evidence` (PR #2352, squash
`6b28c59d`): 2 of the 5 files were byte-identical, **3 differed**, and `git diff <branch> origin/main`
listed 9 lines existing only on the branch. That reads exactly like work about to be stranded. It was
not. Name the commit that changed them:

```bash
git log --oneline "<squashSHA>..origin/main" -- <the differing files>
```

Exactly one came back — `3cf00925` (#2354), itself merged — and all 9 lines were the pre-#2354 form
of lines #2354 rewrote. **Superseded, not lost.** So the gate stays the merged PR plus
`git merge-base --is-ancestor <squashSHA> origin/main`; the blob comparison only tells you whether
anything has moved *since*, and a difference is a question, not a verdict.

**A FOURTH trap, 2026-08-28: a long-lived branch can be merged by MORE THAN ONE PR, so gating on
"its" squash picks the wrong one.** Cleaning six merged branches, a per-branch patch-id gate compared
each branch's cumulative diff against the squash of the PR that branch was known for.
`codex/hr-phase3-boundaries` failed it — `20c2c8e4…` against `#2554`'s `6aedb9b5…` — and the gate
correctly refused to delete. But the branch had kept working *after* #2554 merged, and that later
commit (`e38069c2`, a 990-line feature) merged separately as **`ffa29754` / #2568**, under a
different branch name. The branch was fully absorbed; one PR simply could not account for all of it.
The check that settles it, and the one to reach for whenever a branch outlived its own PR:

```bash
# 1. find WHERE each merge landed: walk the branch, patch-id the cumulative diff at each commit
for c in $(git rev-list --reverse "$(git merge-base origin/main <branch>)..<branch>"); do
  git diff "$(git merge-base origin/main <branch>)" "$c" | git patch-id --stable; done
# 2. definitive absorption: every path the branch touched, against main
git diff --name-status origin/main <branch> -- $(git diff --name-only "$(git merge-base origin/main <branch>)" <branch>)
```

**Step 2's output needs its DIRECTION read, not just its emptiness.** `tests/run-tests.ts` came back
modified, which reads as unmerged work. It was the opposite: **0** lines existed on the branch that
`main` lacked, and **22** existed on `main` that the branch lacked — the shared test registry with
other sessions' registrations added since. Split the diff by `^+` and `^-` before concluding
anything; on a file every branch edits, "differs" is the default state and says nothing on its own.

**How to apply:** before repeating the doctor's warning to the owner as "this can lose work",
run the blob comparison. Saying commits are at risk when they are merged-and-shipped is the kind of
confidently-wrong report that costs a day. Related: [[dont-skip-validation-for-ram-wait-instead]].
