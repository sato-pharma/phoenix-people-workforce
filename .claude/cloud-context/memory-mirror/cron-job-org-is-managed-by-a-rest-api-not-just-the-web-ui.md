---
name: cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui
description: "The production scheduler cron-job.org has a full REST API (key already in .env.local) — jobs can be listed, created, timed in Africa/Cairo, and PROVEN to have run by reading their response body; on Windows curl -d @- silently creates nothing"
metadata:
  node_type: memory
  type: reference
  originSessionId: 95a9153c-7cad-40ba-8918-05de11f9c69f
  modified: 2026-08-28T17:34:25.937Z
---

**The cron-job.org account is scriptable — it is not a black box you can only click.** Confirmed
live 2026-08-23 while moving the two Direct Orders clocks into it.

AGENTS.md calls this account "an undocumented single point of failure whose schedule exists only
inside that account". Half true: the schedule *does* live only there, but it is fully readable and
writable over HTTP, so it can be inventoried, diffed against `docs/observability.md`, and changed
from a session.

Base `https://api.cron-job.org`, header `Authorization: Bearer <CRONJOB_API_KEY>`. **The key is
already in `.env.local`** (44 chars) — never print it.

| Call | Does |
| --- | --- |
| `GET /jobs` | list every job — `jobId`, `title`, `enabled`, `url`, `schedule` |
| `PUT /jobs` | **create** (body `{"job":{...}}`), returns `{"jobId":…}` |
| `PATCH /jobs/{id}` | update |
| `DELETE /jobs/{id}` | delete |
| `GET /jobs/{id}` | detail, incl. `.jobDetails.extendedData.headers` |
| `GET /jobs/{id}/history` | executions: `status` (1 = OK), `httpStatus`, `duration` |
| `GET /jobs/{id}/history/{identifier}` | **the response body** — the only way to prove a job did the work, not just returned 200 |

Job shape: `schedule.{timezone,hours,minutes,mdays,months,wdays}` as **arrays**, `-1` = wildcard;
`requestMethod` 0 = GET; `extendedData.headers` carries the `Authorization: Bearer <CRON_SECRET>`.

**`requestTimeout` IS A LIE — the 30-second cut is a PLATFORM CAP the setting cannot raise.**
Measured 2026-08-28 with a one-shot probe job on `/api/cron/crm-contact-lists`: the API accepted
`requestTimeout=300` without complaint, `GET /jobs` read it back as 300, and the execution still
recorded **`status=5 http=0 ms=30108`**. Writing a value above 30 therefore *looks* like it worked
in every place you can check it. Do not spend time trying to buy more time here.

**But the SERVER DOES FINISH after the cut — the failure is the report, not the work.** Proven the
same night by the route's own audit row, which the handler writes LAST: it landed at **20:09:43
Cairo covering all 82 agents, 9,518 rows, 0 failures**, about **70 seconds after** the client was
killed at 30.1 s. So a long idempotent route completes normally and merely logs a permanent false
`Failed (timeout)`.

⚠ **THE TRAP THAT COST THIS SESSION: a mid-sweep snapshot reads exactly like a truncated one.** A
query run at 20:09:02, while the sweep was still writing, returned "39 of 68 agents re-stamped" and
was reported — confidently, to the owner, into `AGENTS.md` and into two memory files — as proof the
work half-applies. It was simply the run in progress. **Never judge completion from row timestamps
while the job may still be running. Read the terminal artefact instead** — the audit row, the
response body via `GET /jobs/{id}/history/{identifier}`, the final log line — or re-query after the
route's full known duration has elapsed.

Slicing a long route into several ticks is still worth doing, for the honest reason: a permanently
red job is one nobody reads, you never see the response body, and completion depends on a detached
request surviving a container restart. See
[[crm-contact-list-comes-from-contactslist-aspx-not-the-api]].

**It has a real `timezone` field — use `Africa/Cairo`, not UTC.** A GitHub `schedule:` cron is
UTC-only and therefore drifts an hour twice a year with Egypt's DST; here the time is stable.

**Windows trap: `$json | curl.exe … -d "@-"` creates NOTHING and reports NOTHING.** The `@-` is not
expanded, so the body never arrives; the call returns an empty string and a follow-up `GET /jobs`
shows the old count. It looks exactly like success. Use `Invoke-RestMethod -Method Put -Body $json
-ContentType "application/json"` instead. Rapid consecutive creates also **429** — retry after ~20 s.

**Verify a job's secret without printing it** — compare, don't display:

```powershell
$hdr = (Invoke-RestMethod "https://api.cron-job.org/jobs/$id" -Headers @{Authorization="Bearer $key"}).jobDetails.extendedData.headers.Authorization
$hdr -eq "Bearer $((railway variables --environment production --service phoenix-people-workforce --json | ConvertFrom-Json).CRON_SECRET)"
```

**To prove a new job really fires, don't wait a day** — create a throwaway job on the same URL timed
two minutes out (`mdays`/`months` pinned to today so it runs once), read its history body, then
`DELETE` it. That proved the Direct Orders route end to end: `httpStatus=200`, 2901 ms,
`{"success":true,"expired":0}`. Only probe with an **idempotent** route —
`direct-orders-expire-held` is safe, `direct-orders-probation` emails the owner and the CEO.

**16 jobs as of 2026-08-23**, 12 pre-existing + the 2 Direct Orders clocks
([[github-actions-cron-secret-went-stale-after-a-railway-rotation]]) + 2 rotate-sheet-token jobs a
parallel session added. Two of the 16 are **disabled duplicates** —
`phoenix-inbound-intake (Copy)` and a second `phoenix-ireports360-reconcile` — so a duplicate-URL
scan is not automatically a defect; check `enabled` first.

Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] (cron-job.org fires it,
Healthchecks proves it ran), [[ci-jobs-failing-in-seconds-means-billing-not-code]] (why GitHub is
the worse scheduler here — its runs stop dead when Actions billing does).
