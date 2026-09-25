---
name: app-error-events-is-user-triggered-zero-is-not-broken
description: "app_error_events logs real users' browser errors in bursts, so a zero day is ordinary quiet, not a broken writer - and the way to prove the pipeline is a 405-vs-404 differential probe, never a synthetic POST to production"
metadata:
  type: project
---

**A day with 0 rows in `app_error_events` does NOT mean error logging broke.** Checked 2026-08-27
after a 26-hour gap looked alarming next to "80 rows in 7 days". It was ordinary quiet.

**Why zero is plausible: these are REAL USERS' browser errors, and they arrive in BURSTS.** Almost
every recent row is `source = 'client'`, one person hitting one broken page repeatedly - the
2026-08-26 entry is **7 rows in 46 seconds**, all one user on `/employee-portals/submit-expense`
with the same minified JS error. 2026-08-25 was 3 rows in 3 seconds. So the table is not steady
background telemetry that should tick over; it is silent until somebody trips over something.

The volume has also been falling hard as the app stabilised: **98** rows on 08-09, 27 on 08-21,
3 on 08-25, 7 on 08-26. Against 3-7/day, a zero day is unremarkable. Every day in the preceding 30
had at least one row, which is what makes the zero *look* like a signal - it is not one on its own.

## How to actually tell quiet from broken

Do NOT POST a synthetic error to production to test it - that writes a junk row into the very table
the Error Monitor reads. Verify each link instead:

1. **Is anyone using the app?** Zero traffic explains zero errors trivially. On 2026-08-27:
   **206** `activity_events` and **561** `audit_logs`, latest 19:05 Cairo. So traffic was real.
2. **Is the writer gated off?** `logAppError` returns early unless `shouldPersistErrorEvents()`
   (`src/lib/error-monitor/derived-status.ts:50`) - which is just
   `PHOENIX_PERSIST_DEV_ERROR_EVENTS === "true" || NODE_ENV === "production"`. True in prod.
3. **Is the reporting route alive?** `/api/errors/client` is **POST-only**, so a GET returns
   **405** when healthy. **405 alone proves nothing** - pair it with a control:
   ```
   /api/errors/client       -> 405   route exists, wrong method
   /api/errors/nonexistent  -> 404   control: 404s are real here, so the 405 means something
   ```
   Without the control you cannot rule out a blanket status. See
   [[a-role-probe-cannot-trust-the-http-status-code]] and
   [[a-post-to-any-api-path-returns-403-even-if-it-does-not-exist]] - which is also why the probe
   must be a GET.
4. **Did the writer's code change?** `src/lib/error-monitor/service.ts:145` was last touched
   **2026-08-14**, twelve days before the gap opened. A code cause would have to predate the gap.

All four held, so the gap was real quiet.

**What this stops short of.** Every link was verified intact, but the write path was never exercised
end to end - that is negative evidence, not positive proof. To get positive proof, POST a synthetic
error to **staging** (`https://phoenix-people-workforce-staging.up.railway.app`, its own Supabase
project `cifwmndunmlxjhyjugxa`), never production.

**How to apply:** before reporting that error logging has broken, run the four checks above. And
note `environment` is defaulted at insert via `currentEnvironmentLabel()`, so new rows are never
NULL - but old ones can be, and the Error Monitor hides those:
[[error-monitor-hides-null-environment-rows]]. Never filter `environment` out of a diagnostic query.
