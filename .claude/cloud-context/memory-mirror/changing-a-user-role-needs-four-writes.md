---
name: changing-a-user-role-needs-four-writes
description: "Correcting an account's role in the DB takes FOUR writes; updating app_auth_users.role alone leaves the user on their old role until the session expires"
metadata: 
  node_type: memory
  type: project
  originSessionId: 422f0419-f7bf-4727-b203-de3401c5cb27
  modified: 2026-08-10T09:59:51.094Z
---

Fixing a wrong role by hand in production needs **four** writes, not one. Doing only the first
leaves the user on their old permissions:

1. `app_auth_users` — `role` **and** `session_version = session_version + 1`
   (mirrors `shouldInvalidateSessions` in `src/lib/admin/access-control.ts`, which bumps by 1 on
   any role change).
2. `user_access_profiles` — `phoenix_role`, `role` (coarse), `scope_type`. A separate table that is
   easy to miss; the admin UI upserts it in the same transaction as the row above.
3. `auth.users` — `raw_app_meta_data` (`phoenix_role`, `coarse_access_role`, `access_scope`) and
   `raw_user_meta_data` (`phoenix_role`, `access_scope`). **Merge with `||`, never replace** — the
   blob also holds `provider`, `providers`, `email_verified`.
4. `app_sessions` — set `revoked_at`/`revoked_reason` on any row where `revoked_at is null`.

**Step 4 is the one that bites.** `validateAppSession` (`src/lib/auth/app-sessions.ts:127`) compares
the `app_sessions` ROW against the **cookie payload** — never against `app_auth_users`. So bumping
`session_version` does NOT evict a live session: row and cookie still agree on the old value. A
logged-in user keeps the stale role until `absolute_expires_at` (12h). Verified live 2026-08-10:
PD-0010 was mid-session on `role='Employee'`, `session_version=7`, valid another 12 hours.

`auth.sessions` (the Supabase side) is empty for these users — the app runs its own session table,
so there is no third session pile to clear here despite
[[force-logout-everywhere-needs-three-writes]].

Correct values come from `mapPhoenixRoleToCoarseAccessRole` / `mapPhoenixRoleToAccessScopeType`
(`src/lib/auth/supabase-identity.ts:45`): District Manager → `manager`/`TEAM`;
Medical Rep → `employee`/`SELF` (both fall through to the default branch).

Related: [[account-creation-defaults-role-to-employee]].
