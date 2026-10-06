---
name: a-role-count-of-zero-can-mean-mis-roled-not-missing
description: "`select count(*) where role='X'` returning 0 does NOT mean the account is missing — OF-0002 had a complete login (app_auth_users + auth.users + identity + access profile) carrying the wrong role, so the job was the four-writes role change, not a creation. Check by hr_id or job title before building anything"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T04:40:15.596Z
---

Measured 2026-10-06 while preparing the *Inside Phoenix* videos. A count of
`app_auth_users where role='Financial Advisor'` returned **0 on production and 0 on staging**, and
that was reported as "the account does not exist, it must be created". It did exist.

**`OF-0002 · Aya Mostafa`** had a *complete* login the whole time — `app_auth_users` row,
`auth.users` row, an `auth.identities` row and a `user_access_profiles` row — all carrying the role
**`Employee`**. The creation attempt failed on
`duplicate key value violates unique constraint "users_email_partial_key"`, which is how it was
caught. A half-built creation on top of that would have left a second auth user for one person.

**Why:** a role is a *column*, not a row. Counting by role answers "who is labelled X", never
"does a seat for this job exist". The employee's **job title** said Financial Advisor all along.

**How to apply:** before creating any account, look it up **by `hr_id` and by `employees.job_title`**,
not by role — and check all four stores, because a login can be complete in three and absent in the
fourth. Then decide between a creation and the four-writes role change
([[changing-a-user-role-needs-four-writes]]):

1. `app_auth_users.role`
2. `user_access_profiles` — `phoenix_role`, `role`, `scope_type`
3. `auth.users.raw_app_meta_data` — `phoenix_role` **and** `coarse_access_role` **and** `access_scope`
4. `auth.users.raw_user_meta_data` — `phoenix_role`, `access_scope`

Plus **bump `app_auth_users.session_version`**, or a live session keeps the old role, and clear
`force_password_reset` if it is set.

🔴 **Never hand-pick the coarse role or scope.** `mapPhoenixRoleToCoarseAccessRole` and
`mapPhoenixRoleToAccessScopeType` (`src/lib/auth/supabase-identity.ts:44-91`) are the only answer,
and most roles fall to the `default` → `employee` / `SELF`. The auth email is also derived, never
invented: `buildPhoenixAuthEmail` = `phx-` + hex of the lower-cased login id + `@auth.phoenix.local`
(so `of-0002` → `phx-6f662d30303032@…`). `app_auth_users_role_check` lists every legal role string —
read the live constraint, because the comment at
`src/lib/workspace/admin-shell-employee-roles.ts:21` claiming `Financial Advisor` is not permitted
is **stale**; it is.

**If a creation really is needed**, `auth.users` needs `confirmation_token`, `recovery_token`,
`email_change_token_new` and `email_change` set to `''` and not NULL, or GoTrue answers
"Database error querying schema" on every login. Current GoTrue writes one `auth.identities` row
with `provider='email'` and `provider_id = user.id`; older rows here also have a second legacy
identity keyed by email, which is not needed for a new one.

**Verify by rendering, never by reading the matrix** — for the admin rail,
`getSections(getNavigationSections('admin'), 'admin', buildPermissionLookup(permissionMatrix, role), role)`
then `groupAdminSections`. Related: [[the-nav-catalog-is-not-the-rendered-sidebar]].
