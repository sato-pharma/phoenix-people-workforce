---
name: a-branch-with-no-pr-can-be-the-working-copy-of-shipped-work
description: a branch that never had a PR can be the PRE-MERGE working copy of work that shipped under another branch name - 46 of codex/crm-weekly-plan's 48 files were byte-identical to #5095/#5088 on main, so opening its PR would have reverted four days of CRM work; compare each file to the SHIPPING commit, never to today's main
metadata:
  type: project
---

"No PR, commits ahead of `main`, files that differ" reads like abandoned work and can be the exact
opposite. Measured 2026-10-07 on `codex/crm-weekly-plan` (7 commits, 48 files, no PR ever opened):
**46 of its 48 files were byte-identical to `ead9ec3e9` (#5095) and `f3d59df6f` (#5088)**, already on
`main`. It was the working copy; the PRs carried the same commits under different branch names.

**Why:** a diff against TODAY's `main` answers a different question — whether `main` moved on, which it
always has. 42 of those 48 files differed from current `main` for that reason alone, and a trial
`git merge origin/main` produced **36 conflicted files**, which is what reverting four days of a live
module looks like before you notice. The two that matched no shipping commit were the two every PR
touches: `tests/run-tests.ts` (all three new registrations present on `main`) and `AGENTS.md` (its rule
now in `.claude/rules/phoenix-crm-approvals.md`, moved by the module-memory split).

**How to apply:** before restoring or re-opening an old branch, find the commit that SHIPPED its work —
`git log origin/main --grep "<its commit subject>" -i`, subject by subject — and compare its files to
THAT commit with `git hash-object`. Only what matches nothing anywhere is unshipped. A migration is the
loudest tell: that branch's own new migration file was already on `main`, unchanged.
Related: [[a-rollup-can-name-an-already-merged-pr-as-a-member]], [[his-merge-approval-can-name-a-container-that-is-already-gone]].
