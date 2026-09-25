---
name: two-sessions-fixed-one-bug-main-was-never-ci-validated
description: "Two parallel sessions independently fixed the SAME vacation double-charge bug; each PR's CI was green on a tree that lacked the other, so the merged main was a combination nothing had ever validated"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4a13ab2c-b77b-4e77-a1ed-2dd1db5c413b
  modified: 2026-08-21T06:24:15.447Z
---

2026-08-04. PR #1682 (this session) and PR #1690 (a parallel session) both fixed the unpaid-vacation
double-charge, both editing `src/lib/deductions/connectors/vacation.ts`. #1690 merged between this
session's two merges. Git auto-merged them without a conflict and GitHub reported MERGEABLE, so
nothing objected — but **neither PR's CI had ever seen the other's code**, and the squash landed a
combination on `main` that deploys to production within minutes.

It happened to be fine: merging the new `main` back into the branch and re-running gave 575 test
files passing (both PRs' own regression tests included) and a clean cold typecheck. That was luck,
not process.

**How to apply.** A green PR proves the BRANCH is green, not that `main` will be. When other work
has merged since your CI run — especially work touching the same module — the merged result is
unvalidated. After merging, immediately merge `origin/main` back into a worktree and re-run tests +
`tsc --noEmit --incremental false`. Do it BEFORE announcing the deploy is healthy, because on
Railway the deploy is already going out.

🔴 **Check for a duplicate fix before starting.** `gh pr list --state open --search "<module>"` costs
seconds and would have shown another session already fixing this. Two independent fixes for one bug
means double the review surface and a merged behaviour nobody designed.

---

🔴 **IT RECURRED AND GOT WORSE — 2026-08-21: both duplicate PRs actually MERGED, 44 seconds apart.**
Two sessions each re-cut the same orphaned commit for the CRM visit-type CP set
([[crm-visit-type-maps-there-are-three-not-two]]): **#2258** merged 06:20:54Z as `a086665a`, **#2256**
merged 06:21:38Z as `f50d5a4a`. The trees were **byte-identical** (`git diff` between the branches was
empty), so the second squash produced an **empty no-op commit** — `git diff a086665a f50d5a4a` is
empty. **Harmless this time, and only because the duplication was exact.** Had the two sessions
written *equivalent but differently-worded* fixes — which is the normal case, and nearly happened
here — the second merge would have conflicted or, worse, double-applied.

**Three things this adds to the rule above:**

- **`gh pr close` is the tell.** Closing the loser failed with *"can't be closed because it was
  already merged"* — that error is how I learned a second copy had shipped. Check
  `gh pr list --state open` for a duplicate **immediately before merging**, not just before starting;
  the window that matters is the minutes between CI going green and the merge.
- **Verify `main` by reading the FILE, never by reading the PRs.** After two merges of "the same"
  change, the only trustworthy check is
  `git show origin/main:<path>` plus a duplicate scan of the literal
  (`grep -o '\-[0-9]\+' | sort -n | uniq -d`). Confirmed 14 CP codes, 0 duplicates.
- **An empty merge commit still triggers a full Railway production deploy.** `f50d5a4a` changed
  nothing yet shipped and became the live `/api/healthz` revision. A no-op merge is not a no-op
  event.

Related: [[parallel-session-swarm-hazard]], [[stale-checkout-verify-against-origin-main]],
[[harden-can-false-green-on-a-warm-incremental-cache]],
[[a-merge-mid-session-orphans-your-next-push-silently]].
