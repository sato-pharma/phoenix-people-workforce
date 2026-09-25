---
name: a-partial-cron-secret-rotation-leaves-two-fingerprints
description: "A CRON_SECRET rotation that runs out of cron-job.org's 100/day quota leaves the fleet holding TWO different secrets at once; a Healthchecks check still reading 'up' is NOT proof that job authenticated, because its grace window hides a failure that already happened"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9001625d-8bd3-4224-a9e3-07eeb31b335f
  modified: 2026-08-24T00:31:04.694Z
---

**A partial rotation is diagnosed by fingerprint SPREAD, not by any single job.** Found 2026-08-24
chasing one `cron_unauthorized` on `cron/run-synthetic-journeys`.

Sweep every job's header and sha256 it. **Two distinct fingerprints across the fleet = a rotation
that did not finish.** On 2026-08-24 the split was 10 new / 7 old. One fingerprint everywhere means
the secret is not your problem, whatever a log says.

**Why:** editing all 17 jobs costs ~34 API calls against a **100/day** cap
([[cron-job-org-rest-api-is-100-requests-per-day]]). When the quota dies mid-pass the remaining jobs
keep the superseded value and 401 forever, silently. The quota **resets at 00:00 UTC** — confirmed:
a bare `GET /jobs` 429'd at 22:06 and 22:10 UTC, then succeeded at 00:02:00 UTC. Two spaced 429s
rule out the 5/sec burst penalty and mean the day is simply spent; wait for the boundary, do not
retry.

**How to apply:**

- **`Healthchecks status=up` does NOT mean that job authenticated.** It means the grace window has
  not expired yet. On 2026-08-24 `phoenix-direct-orders-expire-held` and `-probation` both read
  `up` while cron-job.org recorded `lastStatus=4` (HTTP error) for their 02:17 / 02:27 Cairo runs
  that same night. Only a check whose ping is NEWER than the incident proves anything. Read
  cron-job.org's own `lastStatus` / `GET /jobs/{id}/history` for the truth.
- **Scope the outage from `GET /jobs/{id}/history`, never from Railway logs** — Railway keeps only
  the current deployment (~20 min) and this repo ships ~30x/day, so one 401 in the log is never
  "one failure". History retains ~25 executions with `httpStatus` per run.
- **Match the job by URL, not by title.** The Healthchecks slug is
  `phoenix-run-synthetic-journeys`; the cron-job.org job is titled `phoenix-synthetic-journeys`
  (id `8220577`). A title match silently finds nothing.
- **Prove the app side without mutating anything:** if other jobs have pinged Healthchecks (`ua=node`
  — written from inside the route, after the auth check) since the last deploy, the running
  container's secret is fine and the stale store is the job header. No probe request needed.
- **Fix the DISABLED jobs too — OWNER RULE 2026-08-24.** The session's first instinct was to leave
  the 5 disabled ones (they never fire, so they cannot 401, and their headers were the last
  surviving copy of the superseded secret). **The owner overruled that and it is the right call:** a
  dead credential parked in a free-tier third-party account is a liability, not an audit trail, and
  a job that is re-enabled later would 401 with nobody expecting it. All 17 now carry one
  fingerprint. Keep it that way — realign the whole fleet, enabled or not.
- **A header PATCH must not flip `enabled`.** The 4 OFF iReports360 jobs and
  `phoenix-inbound-intake (Copy)` are disabled ON PURPOSE; re-enabling the Copy would double every
  inbound intake run. Send only `{job:{extendedData:{headers:{…}}}}`, never `enabled`, then re-read
  and assert `enabled` is unchanged. Verified 2026-08-24: partial PATCH preserved `enabled`,
  `schedule` and `lastExecution` on all five.

**Windows/PowerShell trap that ate the first audit run:** `$H` (a headers hashtable) and `$h` (a
history loop variable) are **the same variable** — PowerShell names are case-insensitive. The
history loop overwrote the auth header with a log record and every later call died on
`Cannot bind parameter 'Headers'`. Name them distinctly (`$Hdr` / `$hx`).

**Concurrency:** on 2026-08-24 another session was patching the same jobs live — one job read STALE
at 00:04:03Z and MATCH at 00:05:32Z, untouched by this session. Re-read immediately before writing
and treat a self-healing job as another actor, not as a fluke
([[guard-every-prod-write-when-another-session-shares-the-queue]]).

Related: [[github-actions-cron-secret-went-stale-after-a-railway-rotation]] (the two-store problem),
[[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]] (API shape),
[[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] (why nobody notices).
