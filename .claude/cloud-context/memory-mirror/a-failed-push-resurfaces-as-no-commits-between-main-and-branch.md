---
name: a-failed-push-resurfaces-as-no-commits-between-main-and-branch
description: "A git push that FAILED on a reset connection reports exit 0 when backgrounded, and its only visible symptom is `gh pr create` answering \"No commits between main and <branch>\" — which reads as a branch defect, not a missing push."
metadata:
  node_type: memory
  type: project
  originSessionId: 6591b3bf-083c-4444-bb06-41a2779e5795
  modified: 2026-10-07T20:15:20.110Z
---

Measured 2026-10-07 on `codex/dispute-thread`. `git push -u origin <branch>` was moved to the
background, the task notification said **exit code 0**, and the output file's last line was
`fatal: unable to access '…': Recv failure: Connection was reset`. The branch never reached origin.

**The trap is the SECOND error, not the first.** `gh pr create` then answered:

```
GraphQL: Head sha can't be blank, Base sha can't be blank,
No commits between main and codex/dispute-thread, Head ref must be a branch
```

Every one of those four clauses points at the branch — a bad base, an empty diff, a ref that is not a
branch — and none of them says *the branch does not exist on the remote*. The natural next moves are
all wrong: rebase, re-commit, check the base, widen the diff.

**How to apply:** after any push, confirm the remote ref rather than the exit code —
`git ls-remote origin <branch>` returns the sha, or returns nothing. An empty answer means the push
did not land, whatever the shell reported. It is the background-exit-status trap
([[verify-the-emitted-artifact-never-the-source]] family) wearing a `gh` error message, and
`git push` failing on a reset connection here is common enough that the retry is routine: the second
attempt succeeded immediately with no other change.

Related: the Git cluster's "`git push` hangs — kill at ~60s and retry" covers the hang; this covers
the fast failure, which looks like a success.
