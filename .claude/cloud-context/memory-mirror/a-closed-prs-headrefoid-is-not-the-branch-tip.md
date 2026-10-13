---
name: a-closed-prs-headrefoid-is-not-the-branch-tip
description: a closed PR's recorded headRefOid can be a sha you never had locally — compare it on GitHub before archiving only the local tip
metadata:
  type: project
---

Retiring `codex/place-checks-tier-ruling` on 13 Oct 2026, `gh pr list --state all` reported #5856's
`headRefOid` as `445fc057d` while both the local branch and `refs/heads/` on origin stood at
`438030c13`. `git cat-file -e 445fc057d` failed — the object was never in this clone — so the
archive push of `438030c13` could have left a PR head unbacked right before `git push --delete`.

**Why:** a closed PR freezes the head it had when it closed, and a branch pushed again afterwards
moves past it; `git fetch` never brings an unreferenced sha, so the local store cannot judge it.

**How to apply:** ask GitHub, not the clone —
`gh api repos/<owner>/<repo>/compare/<local-tip>...<headRefOid> --jq '.status, .ahead_by'`.
`status=behind` with `ahead_by=0` proves the PR head is an ancestor of the tip you archived, so one
`refs/backups/*` push covers it. Anything with `ahead_by > 0` is work only that sha holds — archive
that sha too before deleting the branch. Related: [[a-reused-branch-name-finds-the-old-merged-pr]],
[[a-rollup-can-close-your-pr-and-de-register-its-worktree-mid-work]].
