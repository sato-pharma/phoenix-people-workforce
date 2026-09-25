---
name: app-env-unset-on-staging-made-it-look-like-production
description: "APP_ENV was unset on Railway staging so isProductionRuntime() returned TRUE there, defeating the email fail-safe; fixed 2026-08-27 by setting APP_ENV=staging. The ~18 cron routes it also left open were closed separately by #2479 - the email fail-safe is the half that still depends on APP_ENV"
metadata:
  type: project
---

**`APP_ENV` was set on Railway `production` and NOT set on `staging`** (verified 2026-08-27: 43
staging variables, no `APP_ENV`). Both `isProductionRuntime()` (`src/config/system-settings.ts:61`)
and `currentEnvironmentLabel()` (`src/lib/error-monitor/service.ts:69`) read
`APP_ENV || VERCEL_ENV || NODE_ENV`, and a Next.js production build sets `NODE_ENV=production`
**on staging too**. So **staging identified itself as production** to every one of those checks.

Found by POSTing one synthetic error to staging's `/api/errors/client` and reading the row back: it
came out `environment: production`. **Fixed by `railway variables --set "APP_ENV=staging" -e staging
-s phoenix-people-workforce`** (43 -> 44 vars); re-running the same probe then returned
`environment: staging`. Both probe rows were deleted afterwards, count back to 911.

## Two traps this exposed - the second is the dangerous one

**1. The email fail-safe did not cover staging.** `isForceTestingDelivery()` returns
`!isProductionRuntime()` when `PHOENIX_EMAIL_FORCE_TESTING` is unset, and its comment says that
default "keeps preview/dev from emailing real people". On staging that evaluated to **false** - the
fail-safe was inverted exactly where it was needed. Staging was safe only because
`PHOENIX_EMAIL_FORCE_TESTING=true` is set explicitly. **One variable, no net behind it.** Setting
`APP_ENV` restores the intended belt-and-braces. Related: [[never-fire-bulk-emails-ever]].

**2. CLOSED 2026-08-27 by #2479 - this half of the memory is now HISTORY, not a live exposure.**
Re-verified on `origin/main` 2026-08-28: **0** routes carry `if (!secret) return
!isProductionRuntime();` and **22** carry the hardened `process.env.NODE_ENV === "development"`
form. `NODE_ENV` is inlined at `next build` and Railway sets it on neither environment, so the
bypass now resolves closed on every deployed build **regardless of `APP_ENV`**. The account below
is what was true on 2026-08-27 and is kept as the dated record of why #2479 was written.

**~18 cron/notification routes carried `if (!secret) return !isProductionRuntime();`** - among them
`/api/notifications/process`, `/api/notifications/daily`, `/api/cron/background-jobs`,
`/api/cron/recruitment-email-intake`, `/api/sales/master-map/sheet`. With `CRON_SECRET` unset that
returns **true on any non-production APP_ENV**, i.e. callable unauthenticated by anyone.

**The three iReports360 routes were already rewritten to escape this** - they now use
`NODE_ENV === "development"`, and their comment states the reason: staging is "a 1:1 clone of
production" and the old form "would have been callable unauthenticated by anyone, driving vendor
syncs and mirror writes against production-grade data." **That fix was applied to 3 routes and left
in the other ~18.**

**So setting `APP_ENV=staging` FLIPS that branch from closed to open on staging.** It was safe here
only because `CRON_SECRET` is set on staging (len 64) - so `!secret` is never reached. Verified
empirically before AND after the redeploy: `/api/notifications/process`, `/api/cron/background-jobs`,
`/api/notifications/daily`, `/api/cron/recruitment-email-intake` all returned **401** on both builds.

**How to apply:** the "confirm `CRON_SECRET` first" instruction that stood here is **RETIRED** -
#2479 removed the branch it protected, so `APP_ENV` no longer touches cron authentication at all.
What still depends on `APP_ENV` is the **email fail-safe** in point 1 above, which #2479 did not
touch: that is the reason to keep this memory. And treat `!isProductionRuntime()` as an authentication fallback with suspicion generally:
it reads as "only in dev" and actually means "anywhere not labelled production", which includes any
environment where someone simply forgot the label.

**Also note the CLI is linked to `production`.** `railway status` showed
`Environment: production`, so every command needs an explicit `-e staging`. Setting `APP_ENV=staging`
on production by omission would flip `isProductionRuntime()` false there and redirect **real
employee email** into the test inboxes. Verified after the change that production still reads
`APP_ENV=production`.

Setting a variable **does** trigger a Railway redeploy (no `--skip-deploys` passed): a new staging
deployment appeared within seconds and had to reach `SUCCESS` before the change took effect.
Related: [[a-post-to-any-api-path-returns-403-even-if-it-does-not-exist]] ·
[[app-error-events-is-user-triggered-zero-is-not-broken]]
