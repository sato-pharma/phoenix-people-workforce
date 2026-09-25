---
name: cronjob-2026-08-23-batch-401s-with-a-byte-identical-header
description: "The two Direct Orders cron-job.org jobs 401'd on their first-ever scheduled run even though their stored Authorization header is byte-identical to jobs that authenticate fine."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9e8b1216-66d8-49ed-88cf-b9f92453e937
  modified: 2026-08-24T00:57:00.741Z
---

> **🟢 RESOLVED 2026-08-24 03:52 Cairo — it was REPAIR TIMING, not the batch. Do not reopen.**
> Both jobs were fired by hand from the cron-job.org console's own **TEST RUN**, which sends the
> job's stored header from cron-job.org's servers — the identical path a scheduled run takes.
> `8313165` → **200 OK** in 164ms, `{"success":true,"expired":0}`. `8313177` → **200 OK** in 369ms,
> `{"success":true,"checked":3,"promoted":0,"flagged":0}`. Both then pinged Healthchecks and both
> checks went `grace` → `up` (03:48:38 and 03:52:26), clearing before their 04:17/04:27 `down`.
> **The "it is the BATCH, not the route" theory below is DEAD** — two batch members authenticate
> fine. The 02:17/02:27 401s happened because the header repair landed after 02:27; the guess
> recorded below ("the header those two jobs actually SENT differed from what the API returns now")
> was right. **TEST RUN is the general tool this note should have reached for: it answers a
> "will it authenticate?" question in seconds instead of waiting a day for the next window, at the
> cost of really running the job — so weigh the side effects first.** Here both were no-ops on the
> data (0 expired, 0 promoted, 0 flagged), which is also why the missed 02:17/02:27 runs cost
> nothing. The 2026-08-25 wait was unnecessary.

**2026-08-24, first scheduled runs — both FAILED, and the obvious cause is ruled out.**

`8313165` (`phoenix-direct-orders-expire-held`, 02:17 Cairo) and `8313177`
(`phoenix-direct-orders-probation`, 02:27 Cairo) both executed exactly on time and both got
**HTTP 401**. Railway logs on revision `6b9468ba` confirm the requests arrived from cron-job.org
(UA `cron-job.org`, IP `116.203.129.16`) with `hasAuthHeader: true` — so the header was present
and the secret comparison failed. Neither pinged Healthchecks; both checks sit in `grace`.

**The stale-`CRON_SECRET` explanation does NOT hold on this evidence.** The `Authorization` header
stored on those two jobs hashes to the same `sha256[:12] = 363218fb974a`, len 71, as
`8220577` (synthetic-journeys, 200 at 03:00 today) and `8200914` (process-notifications, 200 at
03:20 today). Route auth code is byte-identical across all three
(`bearerSecretMatches` → `src/lib/security/constant-time.ts`), there is no middleware in this repo,
and the route files are unchanged between `6b9468ba` and HEAD.

**The pattern that does hold: it is the BATCH, not the route.** Every job created 2026-08-23
(`8313165`, `8313177`, `8313169`, `8313171`, `8313297`) has either never run or 401'd. Every older
job (`82*`) authenticates. The only story consistent with everything is that the header those two
jobs actually SENT at 02:17 differed from what the API returns now — i.e. it was corrected after the
failure (both carry `notification.onFailure: true`, so the account emailed on the failure).

**Do not "fix" this by rotating anything.** The decisive test is free: the next scheduled runs are
02:17 / 02:27 Cairo on 2026-08-25, and `8313169` / `8313171` (28 Aug) and `8313297` (1 Sep) are the
same batch. See [[a-partial-cron-secret-rotation-leaves-two-fingerprints]] and
[[github-actions-cron-secret-went-stale-after-a-railway-rotation]].

**🔴 THE FINGERPRINT ABOVE IS OF `"Bearer <token>"`, NOT OF THE TOKEN — re-measure the same way or
you will "discover" a change that never happened.** Re-verified 03:45 Cairo 2026-08-24, after the
#2377 merge: hashing the **whole header value** (len **71**) still gives `363218fb974a`, exactly as
recorded above, while hashing the **token alone** with `Bearer ` stripped (len **64**) gives
`087e2ed88284`. Same bytes, two fingerprints. Both numbers are now in the record because
[[github-actions-cron-secret-went-stale-after-a-railway-rotation]] quotes the *stripped* form
(`8161d7c0d8b7` stale → `087e2ed88284` live) — so a session that compares a figure from one note
against a figure from the other concludes the header was silently rewritten, and rotates something.
**Print `len` beside every fingerprint; 71 vs 64 is the tell.**

Independently re-confirmed at that same reading that `8313165`, `8313177`, `8220577` (200 at 03:00)
and `8200909` all carry **one identical header**, all `enabled=true` — so nothing further can be
learned from comparing them, and the 2026-08-25 02:17 / 02:27 runs remain the only decisive test.

**Timing note that closes the "never ran or 401'd" observation for these two:** `/jobs/<id>/history`
shows both fired exactly on time (02:17:00 and 02:27:00) and 401'd, and the repair that corrected
their header landed *after* 02:27 — the first firing of any job after it, synthetic-journeys at
03:00:03, returned 200. So tonight's two 401s are explained by repair timing alone and are **not**
evidence for or against the batch theory. Consequence to expect: both checks flip `grace` → `down`
at ~04:17 / ~04:27 Cairo, which is a true report of a genuinely missed run, and should self-clear at
02:17 / 02:27 on 08-25. **Tonight's Direct Orders hold-expiry and probation sweeps did not run.**
