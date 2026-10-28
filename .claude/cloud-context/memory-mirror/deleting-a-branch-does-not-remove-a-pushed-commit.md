---
name: deleting-a-branch-does-not-remove-a-pushed-commit
description: "Deleting a remote branch does NOT remove its commits from GitHub — refs/pull/N/head keeps them readable by SHA forever, so a PR is the point of no return for anything sensitive"
metadata: 
  node_type: memory
  type: project
  originSessionId: 37375444-88fb-4740-977c-a056555ade15
  modified: 2026-08-18T15:04:28.741Z
---

Proved on 2026-08-18. A parallel session pushed applicant phone numbers in code comments and opened
PR #2191. The PR was closed and the branch `codex/recruitment-cv-ops-scripts` deleted from origin
with `git push origin --delete`. **The content was still readable afterwards:**

```
git ls-remote origin 'refs/pull/2191/*'
  15de0312…  refs/pull/2191/head          <- survives the branch delete, permanently
gh api ".../contents/<path>?ref=15de0312"  -> still returns the file, PII intact
```

Opening a PR creates `refs/pull/N/head`, which GitHub retains for the life of the repository.
Deleting the branch removes only the branch ref. The commit stays fetchable by SHA, and so does
every file in it. `gh api .../commits/<sha>` answers normally.

**Why:** the instinct after pushing something sensitive is "close the PR and delete the branch" —
that feels like undo and is not. Only GitHub Support can purge a PR ref or garbage-collect an
unreferenced commit. Treat `git push` of a branch that will become a PR as **irreversible
publication** of everything in the diff.

**How to apply:** scan for secrets and personal data BEFORE the push, never after. If something
sensitive has already been pushed, deleting the branch is not the remedy — open a GitHub Support
request to purge the object, and in the meantime judge the real exposure from repo visibility.
This repo is **private** with exactly two collaborators (`it-gawish-hr`, `Omar-3-xx`; `Gawish-1997` until the 27 Oct 2026 account move), which is what
made the 2026-08-18 case tolerable rather than an incident.

Related: [[recruitment-cv-reread-run-reports-live-outside-git]].
