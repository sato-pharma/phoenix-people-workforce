---
name: phoenix-merge-guards-fire-on-another-repos-pr
description: "Phoenix's bash-guard cost clauses judge `gh pr merge` even with `--repo <another repository>`, so a PR in a non-Phoenix repo trips C10 and reads as \"not green\" when that repo runs no CI at all"
metadata:
  node_type: memory
  type: project
  originSessionId: e1b23ac6-5f7b-4d02-a735-40455cc04d5a
  modified: 2026-10-18T21:40:31.032Z
---

Run from a Phoenix worktree, `gh pr merge <n> --repo it-gawish-hr/Sato-Pharma-Website` is
inspected by `.claude/hooks/bash-guard.mjs` as if it were a Phoenix PR. On 2026-10-16 clause
**C10** refused the merge of Sato-Pharma-Website PR #40 ("changes 2 files … THIS PR IS NOT GREEN
YET") — but that repository has **no checks configured at all**, so `gh pr checks` reports none and
the guard can never see green, and `node scripts/rollup-prs.mjs` reads only Phoenix's open PRs, so
its folding advice cannot apply either. (C18, the same-module hold at `gh pr create`, was removed
2026-10-19 and no longer reads any repo.)

**How to apply:** when the owner has named a merge in another repository, stand the clause down with
the documented marker — `PHX_MERGE_OK=1 gh pr merge <n> --repo <owner/repo> --squash` — and say in
one line that the guard fired on a foreign repo. Never close the PR to satisfy the clause, never
fold a foreign repo's work into a Phoenix branch, and never read "no checks reported" there as a
missing gate. The cost rules the clauses defend (one wide PR, no small PR put to him) are about
Phoenix's Actions bill and still apply by judgement, not mechanically, elsewhere.

Related: [[the-small-pr-merge-guard-and-the-classifier-deadlock]]
