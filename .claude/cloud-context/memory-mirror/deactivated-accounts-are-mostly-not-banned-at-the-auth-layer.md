---
name: deactivated-accounts-are-mostly-not-banned-at-the-auth-layer
description: "53 of 55 deactivated accounts have no auth-layer ban — three app gates still hold, but auth.users.banned_until is NOT the thing enforcing deactivation, so never read it as the answer"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10c9e0cd-506e-4881-977d-63fca5e0190c
  modified: 2026-08-28T06:07:49.275Z
---

Measured on production (`ozucdzovmcqvepbozvqf`) 2026-08-28: **55 accounts have
`app_auth_users.is_active = false`. Only 2 carry a live `auth.users.banned_until`.** The other 53
can still authenticate at the Supabase layer.

**This is a defence-in-depth gap, not a live hole.** Three independent application gates stop them,
and all three were verified in code:

1. **Login never finds them.** `src/lib/auth/credentials.ts` filters `.eq("is_active", true)` on
   the lookup, so a deactivated row does not exist as far as sign-in is concerned.
2. **The read-time lifecycle gate rejects the session.** `resolveEmployeeLifecycleGate`
   (`src/lib/auth/server.ts:116`) reads `employees.employment_status` on every session resolution
   and denies anything outside `ACTIVE_EMPLOYMENT_STATUSES` = `{active, on_leave}` — so `resigned`,
   `terminated`, `not_renewed` all fail. It fails CLOSED on a lookup error, and it is re-run on the
   fresh `app_auth_users.hr_id` rather than the token's.
3. A retired ROLE additionally resolves down to `Employee`, see
   [[hr-seats-are-composed-from-a-function-catalogue]].

`updateSupabaseAuthUser` (`src/lib/auth/supabase-identity.ts:141`) DOES set
`ban_duration: isActive ? "none" : longBanDuration`, so the 53 predate that path or were
deactivated by a route that does not call it. Worth closing; not urgent.

**The trap for a future session: do not use `banned_until` to answer "is this account
deactivated?"** It reads `null` for almost every deactivated account here. The authority is
`app_auth_users.is_active` plus `employees.employment_status`.

**And do not read a live session as evidence of access.** 3 deactivated accounts had rows in
`auth.sessions`, and one resigned District Manager (B-74) had page views in `activity_events` at
00:05 Cairo the same morning. That looked like an incident and was not: her employee row and auth
row were both stamped `updated_at 05:10 Cairo` — she was deactivated **five hours after** she
browsed, while still an active employee working her notice. **Check when deactivation happened
before calling activity a breach.** A batch of three accounts was deactivated 05:08–05:10 that
morning ahead of the 1 September HR changes.
