---
name: ci-smoke-login-prod-audit-noise
description: "Root cause for recurring 'Session rejected: app session not found' (missing_app_session) audit noise for login_id a-12 in production — CI's Playwright login-smoke test, not a stale browser tab"
metadata:
  type: project
  originSessionId: 2444ae8c-7d4e-4e0d-9bfc-1d078676b5b4
---

Root-caused 2026-07-18, closing the open side-finding in [[heartbeat-logout-race-force-refresh-403]].

**Symptom**: production `audit_logs` (project `ozucdzovmcqvepbozvqf`) showed login_id "a-12"
hitting "Session rejected: app session not found" (`missing_app_session`) ~196 times/24h, in
bursts of 2-3 a second or two apart, recurring every ~15-20 min, non-stop for days.

**Not a stale tab.** No service worker / periodic-sync exists in this codebase, and each burst
uses a **distinct, never-repeated `sessionId`** (confirmed via `(new_values->>'sessionId')` in
the audit rows) — a single stuck tab replaying one dead cookie would show the SAME session id
every time, not ~196 unique ones. A valid signed `phoenix_session` JWT can only be minted by the
server (`createSessionToken` in `src/lib/auth/session-token.ts`), so each burst implies a genuine
successful "login" roughly every 15-20 min, 24/7.

**Actual mechanism**: `a-12` / password `12345678` is the hardcoded CI smoke-test account
(`CI_SMOKE_LOGIN_ID` in [app/api/auth/login/route.ts](app/api/auth/login/route.ts):164-165, used
by [tests/e2e/auth.setup.ts](tests/e2e/auth.setup.ts)). It happens to alias the real HR_ID of Ali
Mohamed Ali Elsayed, an actual active National Sales Manager — coincidence of the test fixture
reusing a real seeded account's HR_ID, not a compromise of his account. When
`PHOENIX_CI_SMOKE_LOGIN=true` and `APP_ENV !== "production"` (both true in the `preview-smoke`
job of [.github/workflows/ci.yml](.github/workflows/ci.yml) — runs on every `pull_request` and
every push to `main`/`master`/`codex/work-from-production`), login takes the `ciSmokeMode` branch:
it mints a real signed session cookie with a fresh `randomUUID()` sid, but **deliberately skips
`createAppSession()`** (no `app_sessions` row — the whole point is avoiding a DB dependency for
this smoke check). Playwright then lands on an authenticated page, `SessionSecurityGuard` mounts
for real (it isn't CI-aware) and fires a genuine `POST /api/auth/heartbeat` (plus a 2nd/3rd
near-simultaneous check, most likely the `/login` page's own already-authenticated redirect guard
re-resolving the same stale cookie, or a `focus`/`visibilitychange` resume-heartbeat — not fully
isolated, and not worth chasing further). `resolveSessionState` → `validateAppSession` correctly
finds no row → `missing_app_session` → a real audit-log INSERT. The CI job's
`SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_URL` secrets point at the **production**
Supabase project (confirmed: these rows exist in `ozucdzovmcqvepbozvqf`), not an isolated CI/test
project, so this writes real rows into the live production audit trail on every CI run. Given this
repo's merge velocity (many same-day PRs, parallel cloud sessions per
[[parallel-work-model-2026-07]]), CI fires roughly every 15-20 min around the clock, matching the
observed cadence exactly.

**Severity: benign, not an active incident.**
- DB load is negligible (one indexed `app_sessions` SELECT + one `audit_logs` INSERT per event).
- The real Ali Mohamed Ali (A-12)'s actual sessions are unaffected — verified separately via
  `app_sessions` rows with real residential IPs (`41.236.198.155`, `197.36.96.135`) and real
  browsers, correctly created/revoked (`revoked_reason: "logout"`) with no anomalies. The one
  `revoked`-reason burst tied to his real session (`dd7eff29-...`) IS the same event already
  explained by [[heartbeat-logout-race-force-refresh-403]] — a genuine logout race, unrelated to
  this CI noise.
- The backdoor cannot be triggered on the live production site itself: `APP_ENV=production` is
  confirmed set there (hardened + regression-tested during the GCP migration — see
  `tests/gcloud-migration-hardening.test.ts`, `docs/gcloud-production-migration-audit.md`), which
  blocks `ciSmokeMode` regardless of `PHOENIX_CI_SMOKE_LOGIN`. Not verified directly via `gcloud`
  in this session (no tool access) — inferred from the test coverage + migration audit doc; worth
  a direct spot-check if this area is touched again.

**Residual, non-urgent gaps** (not fixed, no approval sought yet):
1. CI's `preview-smoke` job authenticates against the **production** Supabase project using a
   hardcoded, well-known credential pair, relying entirely on the `APP_ENV` gate to stay inert —
   a latent risk (single point of failure) more than an active one.
   Recommended fix: point that job's Supabase secrets at the isolated staging project
   (`cifwmndunmlxjhyjugxa`, see [[agents-md-stale-staging-ref]]) instead of
   reusing production credentials. Infra/secrets-only change, touches no app code.
2. This noise pollutes the production security audit trail (`audit_logs`, `entity_type =
   'auth_session'`) with ~200/day rows indistinguishable at a glance from a real anomaly —
   exactly what triggered both this investigation and the earlier heartbeat-race one. If (1) isn't
   done, consider a narrower code-level suppression (e.g. a `ci: true` claim on the smoke-login
   JWT that `auditSessionRejection` checks to skip the write) — but that touches
   `src/lib/auth/server.ts`, which per AGENTS.md needs explicit approval as an auth-adjacent
   change.

**How to apply**: if `audit_logs`/`entity_type='auth_session'` noise for `a-12` resurfaces or
grows, it's CI cadence, not a security event — check `auth_login_attempts` for `a-12` (should show
almost nothing, since `ciSmokeMode` bypasses that table too) and `app_sessions` for `a-12` (real
sessions have real IPs/user-agents; CI-orphaned ones simply never appear there at all, since the
row is never created) before treating it as suspicious.
