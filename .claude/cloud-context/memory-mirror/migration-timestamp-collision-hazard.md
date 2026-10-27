---
name: migration-timestamp-collision-hazard
description: "Concurrent Claude Code sessions on this repo can pick the exact same round migration timestamp independently, failing CI's duplicate-timestamp guard after merge"
metadata: 
  node_type: memory
  type: project
  originSessionId: e6f0b8c9-551d-4fe5-998a-6ab6fa3f6abd
  modified: 2026-07-28T09:40:49.119Z
---

Round-number migration timestamps collided **three times in one session** while building the Deductions module ([PR #1334](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1334)) — `20260725130000` (vs a probation/timezone fix), `20260725140000` (vs `drop_dead_lifecycle_views`), then `20260725120000` (vs `automated_payroll_special_situations`). Each time: created locally, gate-tested green, pushed, then CI's `check:migrations` failed because a *different* PR had merged to `main` in the meantime with the identical timestamp. Seven migrations landed on main during a few hours of work. Local `check:migrations` never catches this in advance — it only sees the current worktree, not what has since merged upstream.

**The third one is the lesson: fixing one collision does not protect the others.** After renaming two files I still had a third round-numbered migration sitting there waiting to collide. Rename ALL round-numbered migrations on the branch at once.

**Why:** Multiple concurrent sessions on this repo (see [[parallel-session-swarm-hazard]], [[parallel-work-model-2026-07]]) each generate migration timestamps independently, and round numbers (on the hour/half-hour) are a common, low-entropy convention — so collisions recur specifically at round values, not general timestamp collisions.

**How to apply:** Never use a round on-the-hour/half-hour timestamp — always append arbitrary minute/second digits (`20260725141943`, not `20260725140000`). Before pushing, `git fetch origin main` and check EVERY migration on the branch, not just the newest one:

```bash
for f in $(git ls-tree -r --name-only HEAD -- supabase/migrations/); do
  ts=$(basename "$f" | cut -c1-14)
  hit=$(git ls-tree -r --name-only origin/main -- supabase/migrations/ | grep "/$ts" | grep -v "$(basename $f)")
  [ -n "$hit" ] && echo "COLLIDES: $ts -> $hit"
done
```

If CI's `validate` job fails fast (~30s) on a PR whose lint/typecheck/test/build all pass locally, check `check:migrations` output first — a duplicate-timestamp collision with a since-merged PR is the likely cause.

**RECURRED 2026-07-28** (I ignored this memory): used round `20260728100000` for `au_resign_vacate_all_open_seats` (#1416); #1415's `restore_report_rpc_statement_timeouts` merged first with the same round timestamp; each PR was green alone; **main went red** after #1416 merged. Fixed via [PR #1418](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1418).

**TWO different fixes depending on state — this is the key refinement:**
- **Collision caught PRE-MERGE / not-yet-applied:** `git mv` your file to a NON-ROUND timestamp (the MCP assigns its own server-side `version`, so renaming an un-applied or staging-only file is safe).
- **Both colliding migrations ALREADY APPLIED to prod (the 07-28 case):** do NOT rename — add the timestamp to `GRANDFATHERED_DUPLICATE_TIMESTAMPS` in `scripts/check-migrations.mjs` (only the `.mjs` runs in CI via `check:migrations`; `.js` is dead). The check's own comment says applied dups "cannot be renamed without breaking Supabase migration history," and renaming introduces a repo-filename-vs-`schema_migrations.name` divergence. Grandfathering renames nothing → zero new risk. Guard then WARNS instead of failing.

**PREVENTION (what I should have done):** never use round on-the-hour timestamps; before pushing ANY migration, `git fetch origin main` and run the collision grep above over EVERY migration on the branch. A round timestamp like `100000` is the single highest-collision-risk value.

## RECURRED 2026-07-28 — turned main RED and blocked all deploys

PR #1415 and PR #1416 (different sessions) both authored `20260728100000_*.sql`. Each was GREEN
on its own branch — neither branch contained the other's file — so the collision only existed
once both merged. `check-migrations` then failed on main, and the deploy workflow's `gate` job
correctly refused to ship an un-CI'd commit, leaving four merged PRs unshippable. Fixed by
PR #1419 renaming one to `20260728100500`.

**Rules:**
1. Derive migration timestamps from the REAL UTC clock at authoring time — both collisions came
   from picking a round `HHMM00` value hours ahead of the actual time.
2. Branch CI passing is NOT sufficient. Re-check `pnpm run check:migrations` against the merge
   result, especially when other sessions have open PRs.
3. When choosing which colliding file to rename, move the idempotent/settings-only one, never the
   one carrying logic.

**Renaming is DB-safe:** `apply_migration` assigns its OWN version at apply time (this file was
recorded as `20260728091622` on staging, and production the same way), so the filename was never
the recorded version. Renaming cannot desynchronise an environment that already applied it.
