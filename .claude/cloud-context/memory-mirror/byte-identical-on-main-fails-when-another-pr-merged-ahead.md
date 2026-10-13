---
name: byte-identical-on-main-fails-when-another-pr-merged-ahead
description: "the retire gate \"every changed file is byte-identical on origin/main\" aborts on a SHARED file like tests/run-tests.ts when another PR merged ahead — compare the merge commit's own added lines instead"
metadata:
  node_type: memory
  type: project
  originSessionId: 0a3a0a02-b55f-42bb-8f6f-7c578d5fd602
  modified: 2026-10-13T03:41:03.858Z
---

Retiring a worktree asks whether the branch's work really landed, and the gate that AGENTS.md §5
and the removal script print is **"every file the branch changed is byte-identical on
`origin/main`"**. On 13 Oct 2026, after #5845 merged as `cbbc31c76`, that gate aborted on
`tests/run-tests.ts` — and the work had landed perfectly. #5841 and #5842 merged **ahead** of it
and added their own lines to the same file, so main held all three changes and a blob comparison
read as *"my change is missing"*.

**Why:** the gate exists for a different failure — a REUSED branch name whose old merged PR is
found instead of yours. It answers that by content, which also makes it answer "did main move on?"
with the same word. Eight of the nine files were identical; the ninth is the file every new test
registers in, so it is the one most likely to be shared.

**How to apply:** for a file that differs, do not accept it on faith and do not refuse on the blob.
Compare the lines **the merge commit itself added on main** with the lines the branch adds:

```
git diff origin/main...HEAD -- <file>        # what the branch adds
git show <merge-sha> -- <file>               # what landed on main
```

Equal added-line sets prove the change is on main while allowing main to have moved. Both reads use
`git ls-tree` / `git show`, never `git rev-parse <rev>:<path>`
([[a-rev-colon-dot-path-reads-as-absent-on-main]] — MSYS mangles the colon). The merged PR is still
asked for by NUMBER, never by head name ([[a-reused-branch-name-finds-the-old-merged-pr]]).
