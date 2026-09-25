---
name: force-logout-everywhere-needs-three-writes
description: "Logging an account out \"from everywhere\" takes THREE writes — revoking app_sessions alone leaves the account reachable, and none of the three silences the Phoenix phone app; only the dashboard's Force logout deletes its push subscriptions."
metadata: 
  node_type: memory
  type: reference
  originSessionId: e6e6e590-4673-4879-ad05-2e65afcfe0ee
  modified: 2026-09-18T09:16:52.302Z
---

"Log X out from everywhere" is **three** separate writes in production. Doing only the first —
the obvious one — leaves the account reachable.

1. **Revoke the app sessions.** `update public.app_sessions set revoked_at = now(),
   revoked_reason = '<reason>' where lower(login_id) = '<id>' and revoked_at is null`.
   Note most rows here are long-expired but still have `revoked_at is null` — the app never
   back-fills them, so the row count is far larger than the live count. Live means
   `revoked_at is null and absolute_expires_at > now() and idle_expires_at > now()`.
2. **Bump `app_auth_users.session_version`.** This is the real kill switch:
   [src/lib/auth/server.ts:333](src/lib/auth/server.ts) rejects any cookie whose `ver` differs
   from the stored value, so it kills sessions that have no `app_sessions` row at all. Step 1
   without step 2 is not a complete logout.
3. **Delete the Supabase bridge sessions.** Super Admin / CEO / Finance Manager / SFE Manager /
   National Sales Manager are `privilegedSupabaseBridgeRoles` ([src/lib/auth/app-sessions.ts]
   (src/lib/auth/app-sessions.ts)), so they hold a *separate* GoTrue session pile keyed on
   `app_auth_users.auth_user_id` — `delete from auth.refresh_tokens where user_id = '<uuid>'`
   then `delete from auth.sessions where user_id = '<uuid>'`. These accumulate hard: admin-HR
   had **216 sessions / 236 refresh tokens** against only 6 live app sessions.

**The phone app's notifications are a separate thing, and hand-run SQL never stops them.** None
of the three writes touches OneSignal, and Phoenix sends by external id, which OneSignal fans out
to every subscription the person has — so after a SQL-only logout the Phoenix Android app keeps
showing their notifications. Since 2026-09-18 (PR #4005) the Activity Control dashboard's
**Force logout** does it: `forceLogoutUser` (`src/lib/activity/service.ts`) calls
`stopPhoneAppPushForEmployee` (`src/lib/notifications/settings.ts`), which deletes the person's
app subscriptions at OneSignal and marks those `push_subscriptions` rows unsubscribed.
- App rows are `device_type = 'mobile'` AND `user_agent` starting "Phoenix Workforce app"
  (`describeThisDevice` in `mobile/src/lib/push.tsx`). Phone BROWSERS and computers are left
  alone on purpose: OneSignal's web SDK never re-creates a deleted browser subscription when the
  same person signs back in, so deleting one would silence that browser for good.
- That button does write 1 only (every spelling of the HR id) — not writes 2 and 3. A complete
  "from everywhere" is the three writes above PLUS pressing Force logout; pressing it again is
  harmless and retries any phone that failed. A failure there never undoes the logout.
- The app gets its notifications back by itself when the person signs in to it again.
- Residual: a lost phone that is never opened again can still get a new subscription if Android
  renews its push token in the background (written up in `mobile/README.md`).

**What this does NOT do, deliberately:** it does not revoke passkeys
(`public.app_auth_credentials`) and does not change the password. Both are re-entry paths that
survive a force-logout — which is correct for "log out", but if the intent is "someone may be in
the account", revoking the passkey and rotating the password are separate, additional steps.
Passkey revocation is `revokeAllCredentialsForLogin` in `src/lib/auth/webauthn.ts`; raw SQL
bypasses it, so nothing revokes passkeys as a side effect of the three writes above.

Related: [[app-visibility-is-application-scoped-not-rls]],
[[supabase-mcp-and-cli-revoked-2026-08-02]].
