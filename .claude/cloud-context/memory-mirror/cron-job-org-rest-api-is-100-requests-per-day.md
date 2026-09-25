---
name: cron-job-org-rest-api-is-100-requests-per-day
description: "The cron-job.org REST API allows only 100 requests PER DAY by default, so any bulk edit across the 17 jobs can strand the system half-changed with no way back."
metadata:
  type: reference
---

**The binding limit is 100 requests per DAY, not per second.** The docs advertise
"Max. 5 requests per second" per endpoint, which is what you notice first and is *not* the
constraint that bites. Verbatim: "By default, this limit is 100 requests per day, but can be
increased upon request. For sustaining members, a higher limit of 5,000 requests per day
applies." Exceeding it returns **429 with no `Retry-After` header**, on *every* endpoint
including a bare `GET /jobs` — so an exhausted day is indistinguishable from a burst penalty
unless you know this number.

**Editing all 17 jobs costs ~34 calls minimum** (one GET + one PATCH each, plus the list).
That fits in a day's budget exactly once. It does not survive a retry storm: an exponential
backoff loop wrapped around a failing call spends the remaining quota in minutes, and **429
responses appear to count against the quota too**, so retrying actively delays recovery.

**Never fan out concurrent requests across the jobs.** 17 parallel GETs tripped the limit
immediately on 2026-08-23. Go sequential, one attempt per call, and treat the *first* 429 as
"stop for today", not "back off and retry".

**Why this is dangerous and not merely annoying:** a bulk header change is a two-sided
operation — the app's `CRON_SECRET` on Railway, and the `Authorization: Bearer` header on each
job. If the quota dies between the two sides, the jobs 401 and **you cannot roll back**: the
previous secret's only surviving copy is inside those job headers, and reading one costs a
request you no longer have. Railway holds only the current value, GitHub Actions secrets are
write-only, and the generating process's memory is gone. Plan the order so the recoverable
side moves last, or capture the outgoing value somewhere durable *before* you start.

The failure is quiet from the app side: it logs `cron_unauthorized` with
`context.hasAuthHeader: true`, which is the tell that the caller is still calling and still
sending a bearer token — just a superseded one. It never logs the token itself.

Every scheduled job here is an idempotent poller, so an outage of hours is **delay, not lost
work** — the backlog drains on the next successful firing. That is what buys the patience to
wait for the quota instead of scrambling.

See [[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]] for the API shape itself,
[[github-actions-cron-secret-went-stale-after-a-railway-rotation]] for the two-store problem
that motivates rotating in the first place, and
[[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] for why nobody would notice.
