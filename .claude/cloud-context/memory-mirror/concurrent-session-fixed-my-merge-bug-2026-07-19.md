---
name: concurrent-session-fixed-my-merge-bug-2026-07-19
description: "A SECOND live Claude session was committing into the SAME worktree and silently fixed my TS2451 duplicate-roster merge error, so my clean typecheck re-run was clean because THEIR commit landed on disk - not because clearing .next cured a stale cache. Never attribute a self-healing build error to caching without first checking git log for new commits between the two runs, and stash rather than discard WIP found in a shared worktree."
metadata: 
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

**What happened:** resolving PR #1169's (`codex/dv-planner-wave2-digest`) merge conflict against `origin/main` in worktree `_wt-dv-digest`, my resolution of a conflict in `src/lib/double-visit-analytics/service.ts` left BOTH sides calling `buildDvPlannerRosterEntries` into `const roster`, causing a real `TS2451: Cannot redeclare block-scoped variable 'roster'`. I re-ran typecheck after `rm -rf .next` and it came back clean, and I wrongly concluded this matched an earlier-documented stale-`.next`-cache false positive from earlier this session. It did NOT — a second, independent Claude Code session (co-authored the same way, `Phoenix-HR <phoenix@satopharma.com>` / `Co-Authored-By: Claude Sonnet 5`) was concurrently committing to that exact same worktree and had, in the interim, pushed a real fix (`ac19094 fix(dv-planner): remove duplicate roster block from merge resolution`) that correctly diagnosed and removed the actual duplicate call — my "clean" re-run was clean because of THEIR fix landing on disk, not because of the cache clear.

That same session also committed a separate, legitimate owner-directed change (`3a6ee079 fix(dv-planner): disable weekly digest auto-send, keep digest code` — "Owner wants the weekly send cancelled, not the whole feature discarded") that exactly matched a partial, uncommitted WIP diff I had found and stashed earlier in that same worktree before starting my own merge — confirming that WIP was real, deliberate, owner-directed work in progress, not an abandoned/stale edit as I'd guessed. No harm done (I stashed rather than discarded it, and they simply redid it properly), but it could have gone worse.

**Why this matters:** `_wt-dv-digest` is a pre-existing worktree (not one I created), and another live session was actively using it AT THE SAME TIME I was. See also [[parallel-session-swarm-hazard]] and the `SessionStart` hook's standing warning about the primary checkout — the same collision risk applies to ANY shared worktree, not just the primary directory.

**How to apply:**
1. Before doing substantial work in a pre-existing worktree (one you didn't just create this session), check `git log` there for very recent commits/timestamps as a cheap signal of concurrent activity, not just uncommitted `git status` noise.
2. Don't assume a typecheck/build error "fixed itself" on a clean re-run means stale cache — first check `git log` for new commits between your two runs. Only attribute to cache if the commit history is unchanged.
3. When you find uncommitted WIP in a shared worktree that looks like a partial/incomplete edit, stashing (not discarding) is the right instinct — this incident is a concrete case where that WIP turned out to be real, intentional, owner-directed work.
4. Before pushing your own conflict-resolution/fix work to a branch, `git fetch` and compare against origin first — if someone else already pushed a fix, prefer verifying their result over re-doing it yourself.
