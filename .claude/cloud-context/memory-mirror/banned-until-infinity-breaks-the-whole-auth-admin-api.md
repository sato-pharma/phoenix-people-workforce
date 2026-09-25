---
name: banned-until-infinity-breaks-the-whole-auth-admin-api
description: "A single auth.users row with banned_until='infinity' makes GoTrue 500 on EVERY admin listUsers page containing it — Studio's Auth users list, repo:doctor's orphan check, and the app's own stale-link recovery. Found and repaired on prod admin-HR 2026-08-19."
metadata:
  node_type: memory
  type: project
---

**One poisoned row takes down the whole Supabase Auth admin API.** GoTrue scans `banned_until`
into a Go `time.Time`, which cannot hold a non-finite `timestamptz`. Any request whose result set
includes that row returns `HTTP 500 {"code":500,"error_code":"unexpected_failure","msg":"Database
error finding users"}` — in ~90ms, so it reads like a code error, **not** a timeout.

**Why it is so confusing to diagnose:** the failure is *page-shaped*, not global.
`per_page` ≤ 100 returned 200; ≥ 110 returned 500. `page=1&per_page=100` was fine, `page=2` 500'd,
`page=3` was fine. Walking one row at a time, rows 101–105 and 107–110 were fine and **row 106**
500'd. `GET /auth/v1/admin/users/<id>` on that row gives the giveaway variant, *"Database error
loading user"*. **Small probes pass, so it is very easy to call this transient and move on — I did,
once. It is deterministic.**

**Found on production 2026-08-19:** `admin-HR` (`8bb877b8-20c2-4026-bd46-9d475e6fcbab`) had
`banned_until = 'infinity'`. The other two banned accounts (PD-0007, B-157) were finite and listed
fine.

**WHO DID IT — answered from `postgres_logs` 2026-08-19.** A *parallel Claude Code session*, not
the owner and not the app. It ran `scripts/queries/fix-omar-identity-merge-onto-b10.sql` (a file
that exists in NO branch and NO worktree of this repo) through the Supabase **Management API**
(`POST /v1/projects/:ref/database/query`, `user: pat:11406716`) — a dry run at 02:32:22Z and a
`-- PRODUCTION APPLY ... On his word, 2026-08-19: "run it".` at 02:35:20.837Z. The exact statement:

```sql
update auth.users
   set banned_until = 'infinity',
       raw_user_meta_data = raw_user_meta_data
         || jsonb_build_object('merged_into','B-10','merged_on','2026-08-19')
 where email in (... 'admin-hr','phx-1' ...) and banned_until is null;
```

The owner authorised *the merge*; `'infinity'` was the script's own choice. **Retiring an auth
account by banning it must use a finite far-future timestamp** — the app's `876000h` — never
`'infinity'`, or the whole admin API dies.

**The app never writes this value.** `src/lib/auth/supabase-identity.ts` bans with
`ban_duration: "876000h"` (100 years) and the string `infinity` appears nowhere in the repo — so an
`infinity` here always means a direct DB/Studio write, never an app code path. On that row
`raw_app_meta_data.is_active` was still `true`, further proof `setSupabaseAuthIdentityAccess` never
ran. Its `raw_user_meta_data` carried `merged_into: "B-10"` / `merged_on: "2026-08-19"` — keys that
also exist nowhere in the repo. The merge itself was complete and correct: `admin-HR` has no
`app_auth_users`, `user_access_profiles` or `employees` row, only the retired auth login.

**Blast radius is not just diagnostics.** `findAuthUserIdByEmail` pages with `perPage: 1000` and
`throw`s on error, and it is the stale-link recovery branch for `provisionSupabaseAuthIdentity` and
`setSupabaseAuthIdentityAccess`. So while this row existed, **any account create/repair or
activate/deactivate that needed recovery hard-failed**, as did Studio's Auth → Users page.

**Fix (applied to prod 2026-08-19, do not undo):** set it to the app's own convention rather than
lifting the ban — ban timestamp + `876000 hours`, giving `2126-07-26 02:03:57.285706+00`.
Still banned (`banned_until > now()`), now readable. Verified after: full list `per_page=1000` →
**200, 155 users**; the single row → 200. Before-state and rollback SQL:
`scratchpad/admin-hr-banned-until-infinity-before-2026-08-19.json` (session a754a99d).

**Dating the write is impossible from the row itself.** `auth.users` has **no trigger and no
`updated_at` maintenance** — a raw SQL `update` leaves `updated_at` frozen. Here it still read
`02:03:57.285706+00`, which is the timestamp of an unrelated *successful login* by that account
(proving the row was not yet banned at that instant, since GoTrue 400s a banned user at `/token`).
Reading `updated_at` as "when it was banned" is wrong by ~31 minutes. Date it instead from
`auth_logs`: the last `GET /admin/users` → 200 and the first → 500 bracket it (02:09:40 / 02:55:09),
and `postgres_logs` holds the statement itself.

**The merge's own backup table — created by that script, DROPPED on the owner's word 2026-08-19.**
`public.backup_identity_merge_20260819`, 113,398 rows, including 2 `auth.users` rows with their
`encrypted_password` hashes. It was never browser-readable (no grant to `anon`/`authenticated`),
unlike the class in [[ad-hoc-backup-tables-are-anon-readable]]. Non-secret audit record kept at
`scratchpad/identity-merge-b10-audit-2026-08-19.json` (session a754a99d).

**Two things that table revealed, and only a pre-drop diff could have:**

1. **`ON DELETE SET NULL` silently ate 165 attributions.** The merge deleted `app_auth_users`
   `admin-HR` as a duplicate of B-10; `password_setup_tokens_created_by_login_id_fkey` is
   `ON DELETE SET NULL`, so 165 `password_setup_tokens.created_by_login_id` values went to NULL with
   no error. **Restored to `B-10` before the drop** (165 of 166; the odd one was already NULL).
   Generalise: after any identity merge that deletes the loser row, diff every
   `ON DELETE SET NULL` child — the sweep re-points, then the delete quietly un-points.
2. **25 `v2_vacation_approval_steps` rows were deleted** — duplicate `hr` / `step_order 3` rows
   carrying his `PHX-1` identity, 17 approved and 8 pending. Verified harmless: all 25 requests
   still have an `hr` step, now `approver_hr_id = B-10`; **0 requests left without an approver.**

**How to diff a merge backup against live, cheaply** — dynamic counts without creating anything:

```sql
select src_table, src_column, count(*) as backed_up,
  (xpath('/row/c/text()', query_to_xml(
     format('select count(*) as c from %s where %I::text = ''B-10''', src_table, src_column),
     false, true, '')))[1]::text::bigint as now_survivor
from <backup> group by 1,2;
```

Beware two false positives it throws: `*_compact` columns (values are `b10`, not `B-10`) and rows
captured twice because two columns matched — dedupe on the row's own id before counting.

**How to apply:** if `/auth/v1/admin/users` 500s, do **not** conclude "Supabase is degraded" and do
not conclude "transient" from a small `per_page` probe. Bisect by page, then by row, then go
DB-side — `select email, banned_until from auth.users where not isfinite(banned_until)` finds it in
one query. The same question can always be answered without the API at all by joining `auth.users`
to `app_auth_users` **on `hr_id` from the metadata, never on email** — `app_auth_users` holds no
`phx-<hex>@auth.phoenix.local` addresses, so an email join reports every row as an orphan.
Related: [[repo-doctor-orphan-auth-check]], [[account-creation-defaults-role-to-employee]],
[[changing-a-user-role-needs-four-writes]].
