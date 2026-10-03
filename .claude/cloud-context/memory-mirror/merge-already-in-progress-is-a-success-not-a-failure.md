---
name: merge-already-in-progress-is-a-success-not-a-failure
description: "`gh pr merge` answering `GraphQL: Merge already in progress (mergePullRequest)` has NOT failed — the merge is running, and a settle read fired in the same second returns `OPEN null null`, which reads as \"it did not merge\"; wait and re-read before retrying anything."
metadata:
  node_type: memory
  type: project
  originSessionId: 3c1b7da3-77e1-454b-94d7-22abe2fead0b
  modified: 2026-10-03T06:33:05.904Z
---

Measured on 2026-10-03 merging #5214. A background watcher waited for the PR to go `CLEAN` with
`validate` and `checks` green, then merged with `--match-head-commit`. It printed:

```
GREEN AND CLEAN — merging 1843ce4f6bc9428ec1e693446c890ac5d2688004
GraphQL: Merge already in progress (mergePullRequest)
SETTLED: OPEN null null
```

Both lines look like a failure and neither is one. Thirty seconds later:

```
state MERGED   mergedAt 06:32:04Z   merge e31d91f9d   head 1843ce4f6
```

**Why it happens.** GitHub starts the squash asynchronously. A second `mergePullRequest` arriving
while the first is running — the same session's retry, or a parallel session acting on the same
`merge <number>` approval — is refused with that message rather than queued. The settle read that
follows in the same second still sees the PR as `OPEN`, so `mergedAt` and `mergeCommit.oid` come
back `null`.

**What makes it dangerous.** The tempting reactions are all wrong: retrying answers "not mergeable"
on an already-merged PR, and anything stronger (re-merging a rebuilt branch, re-pushing) is real
damage in response to a no-op. It is the same shape as
[[gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded]] — a merge that SUCCEEDED remotely
while the local command reported badly.

**What to do.** Treat `Merge already in progress` and an immediate `OPEN null null` as **UNKNOWN,
never as failed**. Sleep, then settle with
`gh pr view <n> --json state,mergedAt,mergeCommit,headRefOid`, and check the merged head equals the
sha you pinned — that is what proves no empty squash and nothing lost. In an automated
"merge when green" watcher, put the settle read after a short wait rather than immediately after the
merge call, or it reports a false negative every time the API is still working.

Related: [[a-merge-approval-naming-only-a-number-reaches-every-session]] — a terse `merge 5214`
reaches every live session, which is one way two merge calls land in the same second.
