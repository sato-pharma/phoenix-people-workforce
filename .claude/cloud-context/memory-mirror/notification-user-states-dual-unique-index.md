---
name: notification-user-states-dual-unique-index
description: "notification_user_states had TWO unique indexes over the same person, so every bell upsert could 23505 on the non-arbiter index — RESOLVED 2026-07-30 via PR #1474 (code first, then migration); also records the squash-SHA/CI deploy-gate trap"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbaeb912-9113-487f-bde3-b93f1e402c0a
  modified: 2026-07-30T01:31:21.176Z
---

**2026-07-30.** `public.notification_user_states` carried two independent full unique indexes over
the same human: `(notification_event_id, hr_id)` and `(notification_event_id, user_id)`.
`src/lib/notifications/in-app.ts` chose the arbiter at runtime
(`onConflict: identity.userId ? "…,user_id" : "…,hr_id"`). **ON CONFLICT only protects the index it
arbitrates on** — an insert that misses the arbiter but collides on the *other* unique index raises
23505. Production logged `duplicate key … notification_user_states_hr_unique_idx` ~2×/minute.

**Why:** `user_id` stores `access.loginId`, which is NOT stable per person — dev-auth writes
`dev.preview` where a real login writes `A-16`. Production still held 8 such rows for `hr_id='a-16'`
(dev-auth hitting prod, see [[local-env-already-points-at-production]]). Concurrent bell reads are a
second trigger: both clear the arbiter pre-check, both insert, the loser dies on the other index.
All three writers wrap the call in fail-soft handlers, so it never surfaced in the app — the write
just silently never persisted and retried on every poll, forever.

**Fix:** `hr_id` is the sole uniqueness key (canonical + stable); `user_id` is informational.
Const `NOTIFICATION_STATE_CONFLICT_TARGET` in in-app.ts; migration
`20260730120000_notification_user_states_single_conflict_key.sql` drops the user_id unique index and
sets `hr_id NOT NULL`.

**Why:** two unique constraints over one logical identity are always mutually hostile under upsert.

**How to apply:** ⚠️ **ORDERING IS LOAD-BEARING — code first, migration second.** Dropping the
user_id index while old code is deployed turns the silent 23505 into a hard **42P10** ("no unique or
exclusion constraint matching the ON CONFLICT specification"), and `stateSchemaMissing()` does not
match that text, so it rethrows → **500 on every mark-as-read / archive for every user**. The code
change alone fixes the bug with no migration (both indexes exist today, new code just picks the
right one). Verified on staging: old arbiter → 42P10 rejected; new arbiter with a divergent user_id
→ clean update, 84 → 84 rows, no duplicate. Also note the errors are **episodic** — they stop when
the affected user's session ends and resume when they browse again, so "log went quiet" is not
evidence of a fix. Related: [[supabase-advisor-by-design]].

**RESOLVED 2026-07-30.** PR [#1474](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1474)
squash-merged as `c931d6ee`, deployed as revision `phoenix-hr-00658-rij` (100% traffic), and only
then was the migration applied to production. Verified after: redundant index gone, `hr_id` NOT NULL,
219 rows preserved, and a rolled-back probe confirmed the new arbiter handles a divergent `user_id`
cleanly (219 → 219, no duplicate).

**Deploy-gate trap learned the same night — worth its own note.** A squash merge creates a NEW commit
SHA on main that has *no CI run of its own* until CI's `push` trigger finishes. `deploy-cloud-run.yml`'s
gate looks up CI's **conclusion for that exact SHA** and treats in-progress (null) as `"none"`, so a
deploy dispatched right after merging skips — **while the workflow run still reports
`conclusion=success`**. Never read the run conclusion alone; check that the **`deploy` job itself**
says `success`, not `skipped`, and confirm the 100%-traffic revision's `COMMIT_SHA`. Also note
`status.traffic[0]` is NOT the live revision — the SHA-tagged 0%-traffic smoke routes sort first;
filter on `percent == 100`. See [[prod-deploy-scheduled-not-on-push]].
