---
name: heartbeat-logout-race-force-refresh-403
description: "Root cause for spurious 403s on slow/force-refresh actions — SessionSecurityGuard's heartbeat-triggered auto-logout races with in-flight requests"
metadata: 
  node_type: memory
  type: project
  originSessionId: 07ce03c8-ed15-458a-8fb3-209589209988
---

Root-caused 2026-07-18 for a reported 403 on Field Workforce Compliance's "Refresh" button
(`handleSelectLiveMonth(monthKey, true)` → `GET .../live-snapshots/[monthKey]?force=true`).
The page had just rendered fine and a fast non-force read had just succeeded, but the force
click 403'd with "You do not have access to view Field Workforce Compliance data."

**Mechanism**: [SessionSecurityGuard](src/components/auth/session-security-guard.tsx) fires a
heartbeat (`POST /api/auth/heartbeat`) on mount and throttled per-activity. If a heartbeat
returns 401 (real sessions: idle/absolute expiry, `session_version` mismatch, revoked, role
changed — all legitimate per `resolveSessionState` in `src/lib/auth/server.ts`),
`logoutForTimeout()` unconditionally fires `POST /api/auth/logout`
([route.ts](app/api/auth/logout/route.ts)), which deletes ALL FOUR auth cookies (real session +
dev-preview + both Supabase bridge cookies) and then `window.location.assign('/login')`. This is
fire-and-forget with **no coordination with other in-flight or about-to-be-issued fetches**. Any
user action whose request lands around/after that point — especially a slow one like this
force-recompute (13-18s server-side for `buildFieldWorkforceCompliancePreviewFromVisitsReport` +
DB upsert, confirmed live) — hits `assertPermission` with cookies already cleared, resolves to
`anonymousAccessContext`, and gets the generic 403.

**Why other theories were ruled out** (useful if this resurfaces): confirmed via
`mcp__supabase-production__execute_sql` against `audit_logs` (project `ozucdzovmcqvepbozvqf`,
`entity_type='auth_session'`) that no `session_version_mismatch`/`idle_expired`/`role_changed`
events correlated with the repro window; `role_permission_overrides` has zero rows for Super
Admin (rules out the 30s permission-matrix-cache theory — Super Admin always gets
`hr_calendar: allActions` from `defaultPermissionMatrix` regardless of cache state). So the only
way `assertPermission` fails for a Super Admin is the access context itself degrading to
anonymous — which only happens via this cookie-clear race.

**Repro notes**: a clean single-navigation, 30s-idle-wait, then real-click test did NOT reproduce
it locally (dev-preview tokens are 8h and don't naturally expire in that window). It WAS
reproduced once via a chaotic rapid-navigation local test that triggered a real heartbeat-401 →
logout → cookie-wipe → persistent 403 (confirmed with temporary instrumentation, since reverted —
working tree was left clean, `git status`/`git diff` empty). On production, real sessions hitting
idle/absolute expiry or version rotation during normal use are the natural trigger — the race
window is much wider on slow actions because they give the async
heartbeat→logout→cookie-clear→navigate sequence more time to land first.

**FIXED and LIVE 2026-07-18/19** —
[PR #1164](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1164)
(branch `claude/cool-matsumoto-76eeed`) committed/pushed/opened and merged, each step
owner-approved in-conversation separately (commit+push+PR, then merge). Post-merge CI on main
green, Cloud Run auto-deploy succeeded, and production verified live: `gcloud run services
describe phoenix-hr --region=europe-west3` showed revision `phoenix-hr-00118-lad` (tag
`sha-741312a3`, our merge commit) at 100% traffic, and
`https://phoenix-hr.satopharma.com/api/healthz` returned 200 confirming that exact revision.
Implementation, in
`src/lib/auth/client-session.ts`/`src/components/auth/session-security-guard.tsx`/
`src/components/auth/premium-login-page.tsx`/`field-workforce-compliance-workspace.tsx`:
- New same-tab signal: `markSessionInvalidated(reason)` / `isSessionInvalidated()` in
  `client-session.ts`, set by `SessionSecurityGuard` at the START of both logout triggers
  (`logoutForTimeout()` and the heartbeat's 401 branch) — before their async cookie-clear/redirect
  work begins, so other code can observe it moments earlier than before.
- New `handlePossibleSessionDeath(response)` helper: treats a bare 401 as always session-death
  (this app's API convention reserves 401 for "not authenticated"); treats a 403 as session-death
  ONLY when `isSessionInvalidated()` is already true — so a genuine permission-denied 403 (no
  invalidation signal) is never misreported as a session timeout. Redirects to
  `/login?reason=session-timeout` when it fires.
- Wired into field-workforce-compliance-workspace.tsx's own shared `readJsonResponse()` — ONE
  change covers every fetch call site in that file (Refresh, list load, mount-time load, etc.)
  instead of touching each call site individually.
- Login page now shows "Your session expired. Please sign in again." for
  `reason=session-timeout` (previously silent — cookie cleared with zero user-visible message).
- Deliberately scoped to the shared primitive + the ONE reported page, NOT a sweep of every fetch
  call site app-wide (would be a much larger, separately-scoped change) — other pages can adopt
  `handlePossibleSessionDeath` the same way going forward.

Validated: full `pnpm run check:harden` green (lint/typecheck/408 test files incl. new coverage in
`tests/auth-session.test.ts`/build) with zero new errors. Live-verified in the browser end-to-end:
killed the real session via `/api/auth/logout`, set the flag, clicked the real "Refresh" button —
confirmed clean redirect to the friendly login message instead of the old raw 403. Also caught the
REAL heartbeat doing this naturally (no manual trigger) during testing, confirming the wiring
works unassisted, not just under manufactured conditions.

**Separate, unrelated side-finding** (flagged as a background task suggestion): production
`audit_logs` showed login_id "a-12" hitting "Session rejected: app session not found"
(`missing_app_session`) 196 times/24h, in pairs a few seconds apart, recurring every few minutes.
Root-caused 2026-07-18 — NOT a stale browser tab, it's the CI Playwright login-smoke test hitting
production Supabase credentials on every CI run. Full writeup: [[ci-smoke-login-prod-audit-noise]].

See also [[expired-session-page-guard]].
