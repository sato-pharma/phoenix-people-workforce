---
name: his-merge-approval-can-name-a-container-that-is-already-gone
description: a merge approval can name a roll-up that was CLOSED between the ask and his reply - 5409 was built 7 min after its own member 5407 had merged and closed 1 min later, so "merge 5409" arrived for a PR that cannot merge; read state before merging, and ship the live member rather than re-asking
metadata:
  type: feedback
---

A merge put to him can be a CONTAINER that stops existing before he answers. Measured 2026-10-06:
`rollup-prs.mjs` built **#5409** at 19:59 naming #5407 and #5408, but **#5407 had already merged at
19:52** — so the roll-up replaced one merge, not two, and a peer session closed it at **20:00**, one
minute later and correctly (a roll-up whose members landed is CLOSED, never merged). His
`merge 5409` arrived nine minutes after that, for a PR in state `CLOSED`.

**Why:** the quoted words in the `Next step:` box are written before he reads them, and open PRs here
move in minutes. `gh pr merge` on a closed PR fails, and the tempting reads are both wrong — treating
the failure as "he has not approved" re-asks for a decision he just made, and reopening the roll-up
re-merges a member that is already on `main`.

**How to apply:** re-read `gh pr view <n> --json state,headRefOid,mergeStateStatus` **after** his
approval and before merging. If the named PR is a roll-up that is now `CLOSED`, his word was approval
of the WORK: merge the live PR still carrying it (prove it with `git hash-object` on every file), say
in one line that the container was gone and what you merged instead, and never re-ask. Related:
[[a-rollup-can-name-an-already-merged-pr-as-a-member]] — the same window, seen from the roll-up's side.
