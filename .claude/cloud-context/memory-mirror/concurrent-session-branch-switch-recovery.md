---
name: concurrent-session-branch-switch-recovery
description: "A concurrent session checked out a different branch on the shared primary checkout mid-work — recovery recipe for both cases: caught BEFORE the commit (overlap test), and caught after it landed on the wrong branch."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a07c2cca-3ac7-4643-acc0-59ad7345bb0f
  modified: 2026-08-21T06:48:16.799Z
---

2026-07-20: while editing PR1 files on `codex/crm-visit-time-canonical` in the primary checkout, an EXTERNAL `git checkout` (the concurrent session PID 10572, which the SessionStart hook flagged) switched the shared working dir to `codex/ceo-sidebar-probation` between my edits and my `git add`/`commit`. My commit landed on the WRONG branch. `git reflog` showed the tell-tale `checkout: moving from codex/crm-visit-time-canonical to codex/ceo-sidebar-probation` I never ran.

This is the recurring shared-checkout hazard ([[worktree-corruption-parallel-session-2026-07-05]], [[shared-checkout-branch-switched-midsession]]). Nothing was lost because the commit was clean (only my intended files) and origin was untouched.

Recovery that worked (nothing lost):
1. `git branch <backup> <mycommit-sha>` — non-destructive anchor FIRST so the work can never be GC'd.
2. Verify: `git show --stat <sha>` (only my files?), `git rev-parse origin/<theirbranch>` (untouched?), `git reflog` (what switched?).
3. `git checkout -B <my-branch> origin/main && git cherry-pick <sha>` — put my commit on a clean branch off main.
4. `git branch -f <their-branch> origin/<their-branch>` — restore their branch to origin (remove my accidental commit), done while NOT on it so no reset needed.

Lessons: (a) after ANY multi-step edit+commit in a shared checkout, run `git rev-parse --abbrev-ref HEAD` right before `git add` to confirm the branch didn't move under you. (b) The commit output line `[branch-name sha]` is the fastest tell that you're on the wrong branch. (c) Prefer an isolated worktree for new work when the SessionStart hook warns another session shares the folder — per [[parallel-work-model-2026-07]].

## 2026-08-21 — the BETTER case: caught before committing, and the one test that decides it

Same hazard, opposite timing. A session **crashed** mid-work (PID 18564, session `da5b316c`) after committing its own branch, leaving the shared checkout parked on `codex/rep-doctor-lists-campaign-and-noplan` @ `84384fb2` — with **my** 5 untracked + 2 modified brick-coverage files still sitting in the tree. Nothing was lost, but a reflexive `git add`/`commit` would have put my PR on their branch.

**The lock was STALE and that is the documented carve-out.** `.claude/session.lock` named one PID; `Get-Process -Id 18564` returned nothing → not running → AGENTS §5's "hard stop" explicitly does not apply. Check the PID before you treat the SessionStart warning as a blocker; also don't infer it from the *count* of `claude` processes (there were 27 running, in other folders and worktrees). See [[cannot-map-claude-sessions-to-worktrees]].

**The test that decides whether a plain `git checkout` is safe** — this is the part neither prior memory records:

```
git diff --name-only <my-branch-base> <their-HEAD> | grep -E "<my modified files>"
```

- **No overlap** → your dirty files are byte-identical in both trees, so `git checkout <my-branch>` carries your delta across untouched. That is what happened here (their commit hit only 4 `rep-doctor-lists` files). Verified after with `git diff --stat` showing the same 18 insertions.
- **Overlap** → your on-disk file is *base + their edits + yours*, and committing it **smuggles their work into your PR**. Do NOT checkout. Extract only your delta (`git diff HEAD -- <files> > my.patch`) and rebuild it on your branch — or with a temp index and no checkout at all: `GIT_INDEX_FILE=… git read-tree <my-branch>` → `git apply --cached my.patch` → `write-tree` / `commit-tree` / `update-ref`.

Also confirm the delta is genuinely yours before staging: `git diff HEAD -- <files>` and read it. Mine was 18 insertions, all brick-coverage, zero remnant.

**How to apply:** on landing in a shared checkout with a dirty tree, the order is — read `.claude/session.lock` → check that PID is alive → `git branch --show-current` vs. the branch you expect → run the overlap test → only then stage.
