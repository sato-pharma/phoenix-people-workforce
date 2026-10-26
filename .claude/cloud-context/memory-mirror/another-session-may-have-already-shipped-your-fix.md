---
name: another-session-may-have-already-shipped-your-fix
description: "Before building a sales/HR fix, grep origin/main for the behaviour by content — a parallel session may have shipped it hours ago under a different branch name."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 1f989a88-f544-4424-a0da-748e04d44052
  modified: 2026-10-26T09:04:32.467Z
---

Before writing a fix, grep `origin/main` for the **behaviour** (the helper names, the user-visible string),
not for the branch or PR — a parallel session may have shipped the same fix hours earlier.

On 26 Oct 2026 this session built `codex/future-month-readers` (23 files) against a base forked at #6502.
PR #6526 had merged at **07:14 Cairo** that same morning as `c6b7e28b4` and already carried every one of its
fixes — `isFuturePeriod` / `latestNonFuturePeriod` / `toWeeklyCycleMonth` in `src/lib/sales/periods.ts`, the
area-name fallback in `sos-pharmacy-actions.ts`, the capped-list wording in `portal-sos-pharmacy-actions.tsx` —
across **eleven** reader call sites, two of which this branch never touched. PR 6552 was closed as a duplicate
at 12:03 Cairo, after a full validation run and a break-and-restore pass had already been spent on it.

**Why:** ~46 commits a day across many parallel worktrees, and branch names differ for the same bug
(`codex/future-month-readers` vs `codex/future-month-readers-2`), so `gh pr list --head` finds nothing while the
fix is already live. A duplicate also costs a wasted CI cycle and, worse, can *regress* a shipped decision: the
one place the two designs differed, main deliberately ended the Sales Drilldown window at the **latest published
closing** and this branch ended it at the **open month**, which the monthly-closing source of truth forbids.

**How to apply:** first thing after `git fetch origin main`, run
`git grep -n -E "<helper>|<user-visible string>" origin/main -- src app` and `git worktree list` (a sibling
worktree named for the same task is the tell). If main already has it, stop and close — never merge the
duplicate, and never force your version over a shipped design. See [[sos-monthly-closing-is-the-only-sales-truth]]
and [[fix-means-fix-no-unrequested-work]].
