---
name: the-auth-bridge-error-rows-are-a-repair-that-succeeded
description: "`Failed to create Supabase auth session` is the login bridge's FIRST attempt, not an outage - 19/19 rows were followed by a successful login seconds later and 0 of 89 attempts in 24 h failed."
metadata:
  type: project
---

Production `app_error_events` rows reading `Failed to create Supabase auth session` carry the raw
cause `AuthApiError: Invalid login credentials`, which reads like a locked-out employee and like a
spike (19 rows in 7 days, all 19 inside 24 h, 12 inside 2 h on 23 Oct 2026). It is neither.
Measured on production that day: **19 of 19** of those rows are followed within seconds by a
SUCCESSFUL row in `public.auth_login_attempts`, and **0 of 89** attempts in the same 24 hours
failed - the bridge's first sign-in shape fails, the repair path runs, the employee gets in. The
error table is logging a self-healing step as a server error.

**Why:** reading those rows as an auth outage sends a session hunting a live incident that never
happened, and the row count rises with LOGIN VOLUME, so "accelerating" is normal traffic.

**How to apply:** before calling this an outage, join the error timestamps against
`public.auth_login_attempts` (`login_id, ip, success, attempted_at` - the only four columns) and
count `failed`. `auth.audit_log_entries` is EMPTY on this project (0 rows ever), so it answers
nothing. PR #6349 classifies the repair on the raw error instead of the redacted one, which is what
stops the rows. Related: [[the-error-table-never-says-which-needs-you-source-timed-out]].
