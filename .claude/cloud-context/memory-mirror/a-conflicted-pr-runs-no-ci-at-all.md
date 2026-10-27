---
name: a-conflicted-pr-runs-no-ci-at-all
description: "A PR with merge conflicts (mergeStateStatus=DIRTY) gets ZERO CI runs — pull_request workflows need a merge ref GitHub cannot build, so check-runs stays 0 forever and never starts. 🔴 AND NOBODY IS TOLD: an abandoned DIRTY PR is indistinguishable from one merely waiting, so it sits open for ever — two did at once on 2026-10-04, both made DIRTY by a SIBLING PR's squash, not by anything their own authors wrote. The positive proof is `actions/runs?head_sha=<head>` returning total_count 0, never `gh pr checks` saying no checks reported, which reads like not yet. Fix it by REBUILDING the delta onto main, never by merging main in."
metadata:
  node_type: memory
  type: project
  originSessionId: ef45b053-0c83-4e60-94b7-2083401c5d8b
  modified: 2026-10-04T08:44:46.575Z
---

Hit 2026-08-21 on PR #2270. Two pushes in a row produced `check-runs: 0` and
`gh pr checks` → *"no checks reported on the branch"*, while Actions was demonstrably healthy —
other branches got `pull_request` runs in the same minutes and `main` was running `push` builds.

**Cause:** `mergeStateStatus` was **`DIRTY`** (a real content conflict). A `pull_request`-triggered
workflow runs against `refs/pull/N/merge`, and GitHub cannot build that ref while the merge
conflicts — so **no run is ever queued.** Not delayed. Never.

The tell that it was this and not something else: the instant the conflict was resolved and pushed,
`mergeState` went `DIRTY` → `BLOCKED` and two runs appeared on the very next poll.

**Why this is a trap:** `check-runs: 0` is the SAME symptom as
[[a-merge-mid-session-orphans-your-next-push-silently]], and the instinct — "CI hasn't started yet,
poll longer" — burns the whole timeout either way. Three different causes, one symptom:

| `mergeStateStatus` | What `check-runs: 0` means | Fix |
| --- | --- | --- |
| `DIRTY` | conflicted — **no run will EVER be queued** | rebuild the delta onto `main`, push |
| (PR closed/merged) | push is orphaned | new branch off `origin/main`, cherry-pick |
| `CLEAN` / `BLOCKED` | genuinely still starting | poll |

**How to apply:** read `gh pr view <n> --json mergeStateStatus,headRefOid` **first**, before
polling `check-runs` at all. One call separates "never going to run" from "not yet".

## 🔴 The silent half: nothing ever says so, so the PR just sits there

Measured 2026-10-04, when **two PRs were in this state at the same time** and neither owning
session had noticed:

- **#5302** was opened 08:03:00 Cairo and its first workflow run was created 08:28:17 — **25m17s
  with `total_count: 0`**, and only because a session pushed a fix. Nothing was red, nothing was
  pending, no notification fired; on `gh pr list` it reads as an ordinary open PR.
- **#5304** was *opened already conflicted* at 08:30:43 and had no run until 08:50:24 — **19m41s**,
  again only because of a push. Left alone, neither clock would ever have stopped.

Both spans END at an intervention, so they measure how long it took a human to notice, not how
long the state lasts: left alone it is unbounded.

🔴 **So the 2026-08-21 framing — "am I polling something that will never start?" — only covers the
case where somebody is watching.** The worse case is the one nobody is watching: a DIRTY PR is
silently excluded from every gate, every roll-up (`rollup-prs.mjs` builds only from members that
finish GREEN, so it waits its whole 25 minutes and then leaves it out), and from the owner's
attention. **When a worktree cannot be retired or a roll-up comes up empty, read
`mergeStateStatus` on every open PR before looking for anything cleverer.**

**Ask the runs API, not `gh pr checks`.** `gh pr checks` answers *"no checks reported on the
branch"*, which is the same sentence it prints while a run is still being queued. The unambiguous
read is the positive one:

```bash
gh api "repos/it-gawish-hr/phoenix-people-workforce/actions/runs?head_sha=<head>&per_page=20" --jq '.total_count'
```

`0` on a PR that has been open for minutes is proof, not a symptom.

## Where the conflicts come from here — a SIBLING's squash, not only `run-tests.ts`

Both of 2026-10-04's cases came from the same place, and it is **not** the stacked-branch case in
[[a-squash-merge-makes-a-stacked-branch-rebuild-not-merge]] (a child stacked on its own parent).
These were ordinary *siblings*: two PRs that happened to touch one file — `.claude/rules/platform.md`,
which every module-memory change edits — and whichever merged first left the other `DIRTY`. With
module memory in place, `.claude/rules/*.md` is now as collision-prone as `tests/run-tests.ts`
always was, and a session that merges its own PR has a fair chance of silently stalling a peer's.

**The fix is to REBUILD, never to merge `main` in.** Merging re-applies the squashed sibling
against its own squashed self and conflicts in files neither side meaningfully changed — on #5304
that produced three conflicts including a test file, where the honest delta had none:

```bash
git diff <merged head>..<tip> > delta.patch     # the branch's OWN work, nothing else
git checkout --detach origin/main
git apply --3way delta.patch                    # clean
```

To hand it back as a **fast-forward** on somebody else's branch (so nothing of theirs is
overwritten), build the merge commit with plumbing rather than resolving by hand — the tree is then
provably the rebuild and not a judgement call:

```bash
git commit-tree $(git rev-parse <rebuilt>^{tree}) -p <their tip> -p origin/main -F msg.txt
```

🔴 **If the delta regenerates `.claude/rules/*.md`, re-run `scripts/module-memory/build.mjs`
instead of letting the patch carry those blocks** — a hand-carried generated block is exactly what
`build.mjs --check` exists to refuse in the required `validate` job.

**In this repo it also recurs on one file.** `tests/run-tests.ts` is appended to at the tail by
every branch, so with ~30 commits/day and several parallel sessions it collides constantly — #2270
hit the identical conflict twice in twenty minutes as four PRs landed. `git rerere` is on and
replays the resolution, but the durable fix is to **move your registration off the tail**, next to
a related suite, leaving the tail free for whoever appends next. Always re-run
`test-wiring-complete` after resolving: it is the guard against a registration being dropped, which
would make a whole test file silently never run.

Related: [[merge-blocked-says-checks-but-means-behind]] (BLOCKED/BEHIND, a different state that
does run CI), [[gh-pr-checks-lags-behind-the-real-job-state]],
[[a-squash-merge-makes-a-stacked-branch-rebuild-not-merge]],
[[reusing-a-squash-merged-branch-makes-a-conflicting-pr]].
