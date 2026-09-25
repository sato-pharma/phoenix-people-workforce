---
name: shared-checkout-branch-switched-midsession
description: "A parallel session can `git checkout` a different branch in the SHARED main-repo working tree while you're mid-edit — re-verify HEAD/branch before every edit; work in your own worktree."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd464b50-f42d-4423-b2de-142c2cab8435
---

On 2026-07-17, during the iReports360 timezone audit, my assigned worktree (`.claude/worktrees/relaxed-euclid-c858dd`) was an **empty phantom checkout** (not in `git worktree list`, no source materialized), so I read/edited the real tree at the main repo path `F:\Phoenix Workforce\phoenix-workforce`. Mid-session that shared checkout was **branch-switched out from under me** by a parallel session: HEAD moved `d96cb0af [claude/festive-lehmann-d003ea]` → `0357c57c [codex/crm-single-source-module]` (confirmed via `git reflog`: a `checkout: moving from claude/... to codex/...` then a new commit). Symptom that caught it: the same file's line numbers shifted ~11 lines between two greps in the same session (`FWC_TIME_ZONE` at 170 → 159).

**Why it matters:** editing in place would have (a) landed my changes on the wrong branch and (b) collided with a live session committing in the same domain. Stale line numbers also silently invalidate a report written against the earlier HEAD.

**How to apply:**
- Before editing files in the shared main-repo checkout, run `git -C <mainrepo> rev-parse HEAD && git -C <mainrepo> branch --show-current` and confirm it's still YOUR branch. Re-check if a batch of reads spanned time.
- Treat a mid-session line-number drift for an unchanged file as a red flag that the checkout moved — stop and run `git reflog`.
- Don't rely on the phantom/empty worktree; materialize a real isolated worktree for your branch: `git worktree prune && git worktree add "F:/Phoenix Workforce/_wt-<name>" <branch>`, then `npm ci` in it (needs its own node_modules; copy `.env.local` for builds; remove `.env.sentry-build-plugin` so `next build` skips sourcemap upload). Report line:file against a pinned commit.
- The parallel `codex/crm-single-source-module` work (commits `494b6a21`, `0357c57c`) only fixed the CRM **master table** timezone display; it did NOT touch FWC/probation/employee-360/nsm/crm-integrity/route-map — those over-shifts were fixed separately on `claude/festive-lehmann-d003ea` in `_wt-crm-tz-fix`.

Related: [[feedback-parallel-session-pr-collision]] · [[parallel-session-swarm-hazard]] · [[worktree-corruption-parallel-session-2026-07-05]] · [[phantom-worktree-not-in-git-worktree-list]] · [[stale-checkout-verify-against-origin-main]]
