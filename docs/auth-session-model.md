# Phoenix Workforce Auth Session Model

## Current model

Phoenix Workforce uses two linked identity layers:

1. `public.app_auth_users`
   This is the application authority for `login_id`, `hr_id`, Phoenix role, active state, forced reset state, and `session_version`.
2. Supabase Auth + `public.user_access_profiles`
   This is the request-scoped identity layer used for RLS-aware access and user-scoped data reads.

Application sessions are signed with `PHOENIX_AUTH_SECRET` and stored in the `phoenix_session` cookie.

## Session payload

The signed Phoenix session now carries:

- `loginId`
- `hrId`
- `role`
- `authUserId`
- `sid`
- `ver`
- `iat`
- `exp`
- `maxExp`

## Request validation rules

Every protected request that uses `resolveAccessContext(...)` revalidates:

1. the session signature and expiry
2. `app_auth_users` row still exists
3. `app_auth_users.is_active = true`
4. `app_auth_users.force_password_reset = false`
5. `app_auth_users.session_version` matches the signed session payload
6. signed role still matches the database role
7. signed `authUserId` still matches `app_auth_users.auth_user_id`
8. signed `hrId` still matches the canonical employee linkage
9. `user_access_profiles` row still matches the linked auth user, role, active state, and employee linkage

If any check fails, the request is treated as unauthenticated and an auth audit event is written.

## Revocation model

Session revocation is primarily version-based.

`session_version` is incremented on:

- password reset
- account deactivation
- role change
- privilege downgrade

Additional audit/revocation metadata is stored on `app_auth_users`:

- `last_password_reset_at`
- `last_role_change_at`
- `last_session_revocation_at`
- `last_session_revocation_reason`

## Sensitive admin actions

The following operations now require a recent authenticated session, not only a valid long-lived cookie:

- permission override updates
- role changes
- password resets
- account activation / deactivation

Recent-auth enforcement currently uses the signed session `iat` and rejects sensitive actions when the login is older than 15 minutes.

## Dev header auth

Development auth headers are accepted only when all of the following are true:

1. `NODE_ENV === "development"`
2. `VERCEL_ENV` is not set
3. `PHOENIX_ENABLE_DEV_AUTH_HEADERS === "true"`
4. host is localhost-like (`localhost`, `127.0.0.1`, or `::1`)

When used, the server logs a loud warning so local impersonation is visible during development.

## Operational note

The SQL migration `supabase/20260509_auth_session_governance_hardening.sql` must be applied so audit provenance and login-attempt telemetry columns exist in production.
