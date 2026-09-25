---
name: supabase-auth-bridge-password-resync
description: "Slow privileged login = broken Supabase Auth bridge (GoTrue signInWithPassword). Fix = copy Phoenix bcrypt hash into auth.users.encrypted_password (portable $2b$, no plaintext)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a92a7163-f2b7-4768-977a-f47b95254a35
---

**Symptom:** ~10s "Signing in…" for privileged roles (Super Admin, CEO, Finance Manager,
SFE Manager, National Sales Manager — the `privilegedSupabaseBridgeRoles` set in
`src/lib/auth/app-sessions.ts`). Diagnosed 2026-07-05 from a 28s login screen-recording.

**Root cause:** those roles are forced through a Supabase Auth "bridge" —
`createSupabaseAuthSession()` calls GoTrue `signInWithPassword` (`src/lib/auth/supabase-identity.ts`).
The GoTrue password (`auth.users.encrypted_password`) was frozen at the 2026-05-09 bulk provision
while the Phoenix password (`app_auth_users.password_hash`) changed later → sign-in 400s on every
login → falls into a repair that pages the admin user list + retries `createUser` (500s on the
existing email) ≈ 10s. Prod GoTrue logs showed 0 successful `/token` in a 2h window.

**Key facts (verified):**
- Both stores use portable `$2b$12$` bcrypt (60 chars); Phoenix verifies with a plain
  `bcrypt.compare(password, password_hash)` — **no pepper** (`credentials.ts`). So the hash is
  copyable hash-to-hash with **no plaintext**.
- `buildPhoenixAuthEmail(loginId)` = `phx-{hex(lowercased loginId)}@auth.phoenix.local` — this
  matches the stored `auth.users.email`; the email is NOT the problem.
- Only payroll uses the RLS user-session and it falls back to the admin client, so the bridge being
  down doesn't functionally break features — it just makes privileged login slow.

**Fix applied (PR #815, prod 2026-07-05):**
- Migration `20260705140000_resync_gotrue_password_hashes.sql`: `update auth.users set
  encrypted_password = app_auth_users.password_hash` where linked + `$2%` + mismatched. Copying the
  current hash makes GoTrue verify the SAME password the user already uses — **no password changed**.
  Backup: `cleanup_backup.auth_users_pw_backup_20260705` (rollback = restore that column). Prod: 46
  desynced → 0.
- Code hardening: `provisionSupabaseAuthIdentity(input, {hotPath:true})` from login does a single
  `updateUserById` and never the paginated scan/`createUser`; `findAuthUserIdByEmail` capped 3 pages.
- Going forward, change-password + password-setup already propagate to GoTrue, so this was a
  historical desync, not an ongoing code bug.

**Proven on staging** (throwaway user: stale hash → 400; copy hash → signIn success). GoTrue email
sign-in IS enabled in prod (≥1 user had `last_sign_in_at`). Still OPEN follow-up: the separate ~13s
cold **dashboard** load after login. Related: [[vercel-preview-env-and-branching]],
[[auth-terminated-login-block]].
