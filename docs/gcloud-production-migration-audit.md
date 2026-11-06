# Phoenix Workforce — Vercel → Google Cloud Production Migration Audit

_Evidence-based audit performed on the `claude/gcloud-production-migration-audit` branch. Canonical production URL: `https://phoenix-hr.satopharma.com`. Status vocabulary: **CONFIRMED WORKING**, **FAILED AND FIXED**, **NOT VERIFIED — ACCESS OR DATA REQUIRED**._

## 1. Executive verdict

**Migration operational with remaining non-critical items.** The application is live and correct on Cloud Run at the custom domain; authentication, the Supabase bridge, notifications scheduling, email delivery config, and CI/CD auto-deploy are confirmed working. Remaining items are hardening/perf (heavy export routes at the Cloud Run timeout ceiling, per-instance caches, cold starts) and access-gated verifications (authenticated role smoke tests, external dashboards) — none block day-to-day use.

**Users should notice no functional difference** other than the URL. No business logic, navigation, roles, approval chains, or data were changed.

## 2. Current deployment architecture (evidence)

| Attribute | Value | Evidence |
| --- | --- | --- |
| Hosting | **Cloud Run direct** via a Google-managed domain mapping | Response header `server: Google Frontend`; no `cf-ray`/`via`/`x-vercel` headers |
| GCP project | `phoenix-workforce-498619` | `gcloud run services describe` |
| Region | `us-central1` | same |
| Service | `phoenix-hr` (active revision `phoenix-hr-00034-vxb`) | same |
| Cloud Run URL | `https://phoenix-hr-897559113412.us-central1.run.app` (also `…-6k25rcfldq-uc.a.run.app`) | same |
| Ingress / access | `all`; `allUsers` invoker (public) — app enforces auth | `get-iam-policy` shows `allUsers` |
| Runtime limits | concurrency 80, timeout 300s, 1Gi / 1 vCPU, minScale 0, maxScale 3 | `describe` annotations |
| Canonical domain | `https://phoenix-hr.satopharma.com` (Google-managed TLS, HSTS) | `curl -I` |
| Proxy path | None (no Cloudflare / external LB) | headers |
| Supabase | prod project `ozucdzovmcqvepbozvqf` | env |
| Email | Resend (raw `fetch` to `api.resend.com`) | `src/lib/email/send-phoenix-email.ts` |
| Scheduler | Google Cloud Scheduler (4 jobs) | `gcloud scheduler jobs list` |
| Monitoring | Native GCP logging + self-hosted `app_error_events` (Sentry fully removed) | `instrumentation.ts`, no `@sentry/*` |

## 3. Changes implemented

### Code (PR #986, branch `claude/gcloud-production-migration-audit`)

| File | Problem | Fix | Why | Verification | Risk |
| --- | --- | --- | --- | --- | --- |
| `app/api/admin/users/setup-link/route.ts` | Emailed password-setup/reset link origin taken from raw `X-Forwarded-Host` (host-header injection on the highest-value link) | Use `trustedOriginForRedirect()` (allow-list validated, canonical fallback) — same pattern as login | Prevents a forged host from poisoning reset links | New test asserts forged host → canonical; lint/typecheck/build pass | Low |
| `src/lib/synthetic-journeys/service.ts` | `.run.app` host classified as `preview` | Classify `*.run.app` + Cloud Run host as `production` | Correct synthetic-journey environment labeling on Cloud Run | Test asserts `.run.app` recognised | Low |
| `tests/gcloud-migration-hardening.test.ts` (+ `tests/run-tests.ts`) | No migration regression coverage | Added canonical-URL, forged-host, `APP_ENV` detection, opt-in bridge, no-Sentry-CSP, run.app-classification tests | Locks in migration invariants | 334 test files pass | Low |

### Live infrastructure (already applied)

| Change | Problem | Fix | Verification | Risk |
| --- | --- | --- | --- | --- |
| Cloud Run env `PHOENIX_APP_URL` | Set to dead `phoenix-workforce-team.vercel.app` → Telegram links broken | Set to `https://phoenix-hr.satopharma.com` (rev `00034-vxb`) | `describe` confirms; app `/login` 200 | Low, reversible |
| Cloud Run env `NOTIFICATION_DASHBOARD_URL`, `APP_URL` | Unset → email CTA / offer / reset links depended on build-time inlining only | Set both to canonical domain | `describe` confirms | Low |

_Prior-session fixes already merged to `main` and live: Cloud Scheduler dedupe (13→4 jobs), `CRON_SECRET` rotation, `SENTRY_*` env + CSP + workflow removal, `APP_ENV=production`, opt-in strict Supabase-bridge gate (PR #985), Supabase bridge `auth.users` repair (NULL tokens + `instance_id`), auto-deploy IAM (`run.admin` + `serviceAccountUser`), MCP endpoint removal (PR #984)._

## 4. Confirmed working (evidence)

| Item | Method | Result |
| --- | --- | --- |
| New URL loads | `curl -I https://phoenix-hr.satopharma.com/` | HTTP 200, `server: Google Frontend` |
| HTTPS + HSTS | `curl -I` | valid Google cert; `Strict-Transport-Security` present |
| HTTP→HTTPS | `curl -I http://…` | 302 → `https://phoenix-hr.satopharma.com/`, no loop |
| CSP (no Sentry) | response header | `connect-src` has no `*.sentry.io`; self-hosted `/api/errors/client` |
| Security headers | response header | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `COOP`, `Permissions-Policy` |
| Login + Supabase bridge | prod `audit_logs` after real login | `Login succeeded`, `supabaseSessionAvailable=true` |
| Session cookies | code audit | `phoenix_session` host-only (no Domain), HttpOnly, `Secure` in prod, SameSite=Lax |
| Resend webhook auth | `curl -X POST /api/webhooks/resend` (no sig) | 401; GET → 405; svix HMAC + timestamp replay guard + idempotency in code |
| Cron protection | `curl` cron routes without bearer | 401 (fail-closed) |
| Cloud Scheduler | `gcloud scheduler jobs list` | 4 ENABLED jobs, correct `CRON_SECRET`, correct routes |
| MCP endpoint | `curl -X POST /api/mcp` (valid origin) | 404 — route removed |
| Production email guard | env + code | `APP_ENV=production` → `isForceTestingDelivery()=false` (real recipients, not trapped) |
| Rate-limit backing | Supabase schema check | `api_rate_limit_buckets` + `api_rate_limit_consume` present (shared, not per-instance fallback) |
| Ephemeral FS | code audit | No `fs` writes outside `/tmp`; exports stream in-memory Buffers |
| Background work | code audit | No server fire-and-forget; durable DB outbox drained by cron |
| Auto-deploy | GitHub Actions run history | push→`main` builds + deploys to Cloud Run (verified across PRs #984/#985) |

## 5. Failed and fixed

| Symptom | Root cause | Fix | Proof | Deploy still required? |
| --- | --- | --- | --- | --- |
| Telegram notification links point at dead Vercel host | `PHOENIX_APP_URL` on Cloud Run = `…vercel.app` | Set to canonical domain | `describe` shows canonical; rev `00034` serving | Applied (live) |
| Password reset/setup link host-poisonable | Raw `X-Forwarded-Host` used for link origin | `trustedOriginForRedirect` (allow-list) | New test; build passes | PR #986 merge → auto-deploy |
| Synthetic journeys mislabel prod as preview on `.run.app` | Host list missing Cloud Run host | Added `.run.app` | New test | PR #986 |
| (prior) Privileged login lockout | Strict bridge gate keyed on `VERCEL_ENV` (unset on Cloud Run) + Supabase `auth.users` NULL `instance_id`/tokens | Opt-in gate (PR #985) + `auth.users` data repair | `audit_logs` `bridge_ok=true` | Live on `main` |

## 6. Not verified — access or data required

| Item | Why blocked | Exact verification | Risk if unverified |
| --- | --- | --- | --- |
| Authenticated role-based module smoke (Super Admin/HR/Manager/Employee) | No test credentials provided; will not use real employee passwords | Log in with an existing secure test account per role at `https://phoenix-hr.satopharma.com` and exercise each module; or set `PLAYWRIGHT_DATA_USER_HRID`/`_PASSWORD` and run `npx playwright test` | Module-level regressions could exist behind auth |
| Supabase Auth Site URL / redirect allowlist | No Supabase dashboard access in this environment | Supabase → Auth → URL Configuration: Site URL `https://phoenix-hr.satopharma.com`, redirects `https://phoenix-hr.satopharma.com/**`. NOTE: app auth is application-managed (not Supabase Auth redirect flows); the bridge uses the GoTrue **admin/password** API, so redirect config is low-impact here | Low (bridge doesn't use redirect flows) |
| Resend dashboard webhook endpoint | External console | Resend → Webhooks: endpoint must be `https://phoenix-hr.satopharma.com/api/webhooks/resend`, signing secret matches `RESEND_WEBHOOK_SECRET` | Delivery/bounce events not recorded if misconfigured |
| Live email send | No mass sends allowed; needs a single confirmed safe test recipient | With `PHOENIX_EMAIL_DELIVERY_MODE=testing` (or a one-off to `omar.anwar@satopharma.com`), send one labelled test and confirm the link host is `phoenix-hr.satopharma.com` | Cannot confirm end-to-end delivery |
| GitHub secret values (`NEXT_PUBLIC_APP_URL`, keys) | Secret values not readable | GitHub → repo → Settings → Secrets: confirm `NEXT_PUBLIC_APP_URL=https://phoenix-hr.satopharma.com` | Build-time inlined client URL could be wrong (mitigated: runtime `APP_URL`/`NOTIFICATION_DASHBOARD_URL` now canonical) |
| Cloud Run domain-mapping detail | `gcloud beta` component not installable (no admin on SDK dir) | `gcloud beta run domain-mappings describe phoenix-hr.satopharma.com --region us-central1` | Low (headers already confirm Google-managed mapping + valid cert) |
| Attendance "sync-now" on Cloud Run | Architectural: spawns `powershell.exe` against a localhost Windows agent | N/A on Linux; the **inbound** path `/api/attendance/raw-punches` (on-prem agent POSTs in, bearer-authed) is the supported path and works | "Sync now" button non-functional; ingestion still works via inbound agent |

## 7. Environment & secret matrix (no values)

| Variable | Required | Runtime/Build | Public/Secret | Present (Cloud Run) | Non-empty | Notes / Status |
| --- | --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | build+runtime | Public | Yes | Yes | Throws if missing. CONFIRMED |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | build+runtime | Public | Yes | Yes | CONFIRMED |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | runtime | **Secret** | Yes | Yes | Server-only; throws if missing. CONFIRMED |
| `PHOENIX_AUTH_SECRET` | Yes | runtime | **Secret** | Yes | Yes | Session signing; throws if missing. CONFIRMED |
| `CRON_SECRET` | Yes(prod) | runtime | **Secret** | Yes | Yes | Fail-closed 401 if missing; rotated. CONFIRMED |
| `RESEND_API_KEY` | Eff. yes | runtime | **Secret** | Yes | Yes | Soft-skip if missing. CONFIRMED present |
| `RESEND_WEBHOOK_SECRET` | Yes(webhook) | runtime | **Secret** | Yes | Yes | Fail-closed 500 if missing. CONFIRMED |
| `NOTIFICATION_WEBHOOK_SECRET` | Yes(prod) | runtime | **Secret** | Yes | Yes | Telegram webhook. CONFIRMED present |
| `APP_ENV` | Recommended | runtime | Public | Yes (`production`) | Yes | Drives prod detection + email-testing OFF. FIXED earlier |
| `NODE_ENV` | — | build/image | Public | Set in Dockerfile (`production`) | Yes | Not a Cloud Run env var; from image |
| `PHOENIX_STRICT_SUPABASE_BRIDGE` | No | runtime | Public flag | Yes (`false`) | Yes | Opt-in gate OFF. CONFIRMED |
| `PHOENIX_APP_URL` | No | runtime | Public URL | Yes (canonical) | Yes | **FIXED** (was vercel.app) |
| `NOTIFICATION_DASHBOARD_URL` | Recommended | runtime | Public URL | Yes (canonical) | Yes | **FIXED** (was unset) |
| `APP_URL` | Recommended | runtime | Public URL | Yes (canonical) | Yes | **FIXED** (was unset) |
| `NEXT_PUBLIC_APP_URL` | Build | build | Public URL | Build-arg (GitHub secret) | n/a | Runtime empty; verify GitHub secret value (§6) |
| Google Maps / Calendar keys, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `IREPORTS360_*` (iReports360 retired 6 November 2026; no longer read), `ATTENDANCE_AGENT_TOKEN` | Optional/gated | runtime | Secret/Public | Present | — | Optional; degrade gracefully |
| `SENTRY_*`, `NEXT_PUBLIC_SENTRY_*` | No | — | — | **Removed** | — | Not read by shipping code; removed from env+CSP+workflow |
| `PHOENIX_AGENT_SECRET`, `GEMINI_API_KEY` | No | — | — | Not used | — | Not referenced anywhere in code |
| `VERCEL`, `VERCEL_ENV` | No | — | — | Unset (correct) | — | Vercel-only; guarded logic now inert (see §16 P3) |

## 8. Old-domain reference inventory

| File / system | Reference | Classification | Action | Remaining risk |
| --- | --- | --- | --- | --- |
| Cloud Run env `PHOENIX_APP_URL` | `phoenix-workforce-team.vercel.app` | Must-change (prod) | **FIXED** → canonical | None |
| `src/lib/security/origins.ts:10,13-14`; `system-settings.ts:27` | 3 `*.vercel.app` preview origins in CSRF allow-list | Preview/legacy | Documented P2 (tests assert them as intended); prune when Vercel previews decommissioned | Low (company-owned, non-attacker-controllable) |
| `proxy.ts:42` | `VERCEL_ENV === "preview"` gates preview-read-only guard | Preview | Documented — inert on Cloud Run (prod isn't preview) | Low |
| `src/lib/synthetic-journeys/service.ts:91` | `.run.app` not treated as prod | Must-change | **FIXED** | None |
| 7 cron/notification routes | `!process.env.VERCEL && NODE_ENV==="development"` dev-bypass | Ambiguous | Documented — safe (fail-closed in prod via `NODE_ENV`); cleanup only | None (works) |
| Email base-URL builders | env-driven with `systemDeployment.productionUrl` (canonical) fallback | OK | None needed; env vars now canonical | None |
| `docs/*`, `AGENTS.md`, code comments | stale vercel/`vercel ls` mentions | Docs-only | Recommended doc cleanup | None |
| `next.config.ts:120-125`, `supabase/config.toml`, `local-attendance-agent/*`, `tests/e2e/*` | `localhost`/ngrok/local | Local-dev / test-only | None | None |

## 9. Scheduled-job inventory

| Job | Previous (vercel.json) | Cloud Scheduler equivalent | TZ | Auth | Last-run evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Daily notifications | `/api/notifications/daily` `30 6 * * *` | `phoenix-notify-daily` `30 6 * * *` | UTC (matches pre-migration) | Bearer `CRON_SECRET` | success (`bridge`/`status`) | CONFIRMED |
| Outbox process | `/api/notifications/process` `*/30 * * * *` | `phoenix-process-notifications` `*/30 * * * *` | UTC | Bearer | success | CONFIRMED |
| iReports sync | `/api/cron/ireports360-visits-sync` `0 9,12,19 * * *` | `phoenix-ireports360-sync` `0 9,12,19 * * *` | UTC | Bearer (secret repaired) | enabled | CONFIRMED — route and job retired with iReports360, 6 November 2026 |
| iReports reconcile | `/api/cron/ireports360-visits-reconcile` `0 4 * * 0` | `phoenix-reconcile-visits` `0 4 * * 0` | UTC | Bearer | enabled | CONFIRMED — route and job retired with iReports360, 6 November 2026 |

_Note: schedules kept in **UTC** to preserve exact pre-migration (Vercel) timing. `30 6` UTC ≈ 08:30–09:30 Africa/Cairo. Converting to Cairo would shift delivery times vs before — a business decision, not a parity fix. `birthdays`/`contract-renewals`/`holiday-confirmation` run inside the daily job (no separate scheduler needed)._

## 10. Email & webhook verification

- **Resend:** raw `fetch`, `RESEND_API_KEY` present; missing → soft-skip (no crash). FROM `phoenix@send.satopharma.com`, reply-to `phoenix@satopharma.com`.
- **Test-mode:** `isForceTestingDelivery()` = OFF in prod (`APP_ENV=production`), ON elsewhere — the safe direction; dev/preview cannot mass-email real employees (redirect drops CC/BCC).
- **Webhook:** `POST /api/webhooks/resend` only; svix HMAC-SHA256 + ±300s replay guard + timing-safe compare; missing secret→500, bad sig→401, dup→200, transient→503 (safe retry). CONFIRMED (401 live for unsigned).
- **Template links:** vacation/SOS hardcode canonical; notification/offer/password-setup use env base (now canonical) — password-setup additionally allow-list-validated (fix). No `vercel.app`/`localhost` in prod sends.
- **Remaining:** confirm Resend dashboard endpoint URL + one live labelled test (§6).

## 11. Authentication & Supabase verification

- App-managed auth (HR_ID + bcrypt + HMAC-signed `phoenix_session`). Login/logout/session refresh/role gating: code-confirmed; login live-confirmed (`audit_logs`).
- Cookies host-only (no Domain pinning) → domain migration safe.
- Supabase **bridge** (synthetic `phx-…@auth.phoenix.local` GoTrue sign-in) now returns `bridge_ok=true` after repairing `auth.users` NULL `instance_id`/token columns.
- Redirect after login uses allow-list-validated `trustedOriginForRedirect` with canonical fallback.
- **Remaining:** Supabase Auth dashboard Site URL/redirects (low impact — bridge uses admin/password API, not redirect flows); role-based authenticated smoke (§6).

## 12. Cloud Run compatibility

| Dimension | Finding | Status |
| --- | --- | --- |
| Port/host | `PORT=8080`, `HOSTNAME=0.0.0.0`, standalone `server.js` | CONFIRMED |
| Filesystem | No writes outside `/tmp`; exports stream in-memory | CONFIRMED |
| Background work | Durable DB outbox drained by Cloud Scheduler; no server fire-and-forget | CONFIRMED |
| In-memory state | Read-through caches (employee directory etc.) invalidate per-instance → bounded staleness at maxScale 3 | P2 |
| Rate-limit | Shared Supabase-backed (schema present); Map only a degraded fallback | CONFIRMED |
| Timeout/memory | 300s / 1Gi; heavy export/import routes (data-backup, sales-upload/commit, ireports sync) sit at the 300s ceiling; `maxDuration` is a no-op on Cloud Run | P1/P2 |
| CPU/concurrency/scaling | 1 vCPU, concurrency 80, maxScale 3, minScale 0 | maxScale caps Supabase pressure; minScale 0 → cold starts |
| Ingress | `all` + public invoker; app enforces auth on both hosts | CONFIRMED (no bypass) |
| Attendance sync-now | Spawns `powershell.exe` (Windows-only) — dead on Cloud Run; inbound raw-punches works | P2 known-limitation |

## 13. Module regression matrix

Repo check = static/code evidence; Live smoke = unauthenticated only (authenticated marked NOT VERIFIED — no test creds). Roles behind auth need credentialed testing (§6).

| Module | Repo check | Automated test | Live smoke | Status |
| --- | --- | --- | --- | --- |
| Authentication | ✅ | ✅ (auth-session, migration) | ✅ login 200 + `bridge_ok` | CONFIRMED (unauth); role paths NOT VERIFIED |
| Command Center / Employees / Organogram / Vacancies | ✅ routes build | ✅ suite | `/admin` 200 | NOT VERIFIED (auth) |
| Offer lifecycle / Probation / Contract renewal / Resignations | ✅ | ✅ | — | NOT VERIFIED (auth) |
| Leaves / Excuses / Approvals Hub | ✅ | ✅ | — | NOT VERIFIED (auth) |
| Weekly/Monthly plans / Marketing requests | ✅ | ✅ | — | NOT VERIFIED (auth) |
| Sales (monthly/weekly/uploads/dashboards) | ✅; heavy export routes flagged (§12) | ✅ | — | NOT VERIFIED (auth) + P1/P2 perf |
| Field coaching / Payroll / Payslips | ✅ (payslips = portal UI, not emailed) | ✅ | — | NOT VERIFIED (auth) |
| Expenses / Outstation | ✅ (Supabase Storage, durable) | ✅ | — | NOT VERIFIED (auth) |
| Attendance | ✅ inbound; sync-now Windows-only | ✅ | raw-punches 401 unauth | CONFIRMED inbound; sync-now P2 |
| Email Composer / HR Calendar | ✅ | ✅ | — | NOT VERIFIED (auth) |
| Synthetic Journeys | ✅ run.app prod fix | ✅ | — | CONFIRMED (code) |
| MCP | Removed | ✅ (absence) | 404 | CONFIRMED removed |

## 14. Test results

| Check | Result |
| --- | --- |
| Install | (existing `node_modules`) |
| Lint (`npm run lint`) | ✅ pass |
| Typecheck (`npm run typecheck`) | ✅ pass |
| Unit/integration (`npm run test`) | ✅ 334 test files pass (incl. new `gcloud-migration-hardening`) |
| Production build (`npm run build`) | ✅ pass |
| E2E (Playwright) | NOT RUN — requires auth setup / `PLAYWRIGHT_DATA_USER_*` |
| Synthetic Journeys | NOT RUN against prod by design (`global-setup` refuses prod host) |
| Live smoke (unauth) | ✅ (URL, HTTPS, redirect, webhook/cron 401, MCP 404) |

## 15. Security review

| Area | Finding |
| --- | --- |
| Secrets | Not in Git/Docker layers/logs; `.env*` + `cloud-run-env*.yaml` + generators git/docker-ignored; service-role server-only |
| CORS/CSRF | Same-origin mutation guard in `proxy.ts`; canonical origin trusted; webhook/cron/attendance/telegram exempt but each bearer/signature-authed (timing-safe) |
| Cookies | Host-only, HttpOnly, Secure(prod), SameSite=Lax |
| Admin protection | `assertPermission` + explicit Super-Admin checks on admin routes |
| Cron protection | Bearer `CRON_SECRET`, fail-closed 401 |
| Webhook | svix signature + replay guard + idempotency |
| MCP | Removed from prod |
| `.run.app` | No auth bypass (same app auth on both hosts); generated links use canonical env URLs |
| Password-reset link | **FIXED** — allow-list-validated origin |
| Sensitive logging | Health route returns booleans only; no PII/stack traces exposed |
| Dependencies | No migration-driven upgrades made; run `npm audit` for a current CVE list (not auto-upgraded per scope) |

## 16. Remaining production blockers

**P0 (critical):** none — migration is operational.

**P1 (high):**
- Heavy export/import routes (`admin/data-backup`, `sales/sales-upload/commit`, iReports sync) can hit the 300s Cloud Run request timeout / 1Gi memory on very large payloads; `maxDuration` no longer applies. Consider chunking/streaming or Cloud Run Jobs for the largest.

**P2 (improvement):**
- Per-instance read-through caches (employee directory, profile stores) → bounded cross-instance staleness at maxScale 3; consider shared cache or shorter TTL.
- Attendance "sync-now" PowerShell path non-functional on Cloud Run (inbound ingestion works).
- Cold starts (~15–25s) from minScale 0; set `--min-instances=1` if latency matters.
- 3 stale `*.vercel.app` origins still CSRF-trusted (prune when previews decommissioned; update `tests/auth-session.test.ts`).

**P3 (cleanup):** dead `VERCEL`/`VERCEL_ENV` guards in cron routes + `proxy.ts` preview-read-only; stale docs mentions.

## 17. Deployment instructions

- **Files changed:** see §3 (PR #986). **Infra env** already applied (`PHOENIX_APP_URL`/`NOTIFICATION_DASHBOARD_URL`/`APP_URL`).
- **Required secrets/vars:** unchanged; ensure GitHub secret `NEXT_PUBLIC_APP_URL=https://phoenix-hr.satopharma.com`.
- **Build/deploy:** merge PR #986 → GitHub Actions `Deploy to Google Cloud Run` builds from source and deploys (WIF; deploy SA has `run.admin` + `serviceAccountUser`). Manual: `gcloud run deploy phoenix-hr --source . --region us-central1 --project phoenix-workforce-498619`.
- **Post-deploy smoke:** `curl -I https://phoenix-hr.satopharma.com/login` (200); `curl -X POST …/api/webhooks/resend` (401); cron route (401); one authenticated login → `audit_logs` `bridge_ok=true`.
- **Rollback:** `gcloud run services update-traffic phoenix-hr --to-revisions <previous>=100 --region us-central1 --project phoenix-workforce-498619` (previous known-good: `phoenix-hr-00033-g8s`).

## 18. Final go/no-go

1. **New URL safe for all users?** Yes (unauthenticated + login/bridge confirmed; authenticated role smoke pending credentials).
2. **Users notice any functional difference?** No, other than the URL.
3. **Automated emails confirmed?** Config + webhook confirmed; one live labelled send + Resend dashboard endpoint pending (§6).
4. **Scheduled jobs confirmed?** Yes — 4 Cloud Scheduler jobs, authed, correct routes/schedules.
5. **Authentication confirmed?** Yes (login + Supabase bridge live-verified).
6. **External callbacks updated?** Resend webhook route correct + rejects unsigned; confirm the Resend dashboard URL (§6).
7. **Vercel still required?** No runtime dependency. Old Vercel deployment only useful as a temporary rollback reference.
8. **Old deployment disable now?** Safe to retire after (a) confirming Resend dashboard endpoint points at the new domain and (b) authenticated role smoke passes. Keep briefly for rollback.
9. **Before declaring complete:** merge PR #986; run authenticated role-based smoke; send one live labelled email test; confirm Supabase Auth Site URL + Resend webhook URL in their dashboards; confirm GitHub `NEXT_PUBLIC_APP_URL` secret value.
