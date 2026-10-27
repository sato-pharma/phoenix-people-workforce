# Phoenix — infrastructure baseline audit

Read live on **28 Oct 2026, 00:00–00:30 Cairo**, from the Railway API, the Supabase Management API, the database's own metrics
endpoint and the repository. Nothing was changed, restarted or provisioned. No credential or employee record appears here.

Companion documents: [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md) ·
[external compute options](PHOENIX-EXTERNAL-COMPUTE-OPTIONS.md) · [cost and performance](PHOENIX-MAXIMUM-PERFORMANCE-MINIMUM-COST.md) ·
[recommended architecture](PHOENIX-RECOMMENDED-ARCHITECTURE.md) · [roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md) ·
[executive decision](PHOENIX-EXECUTIVE-DECISION.md).

## What runs where

| Piece | Where | Size today |
| --- | --- | --- |
| Web app (Next.js), `phoenix-hr.satopharma.com` | Railway, service `phoenix-people-workforce`, EU West | pay-per-use; the plan lets it use up to 24 vCPU and 24 GB |
| Background worker | Railway, service `phoenix-workforce-worker` | pay-per-use, same ceiling |
| Device-management service and its own Postgres | Railway, `phoenix-headwind` and `headwind-db-eu` | pay-per-use; not part of the Phoenix database |
| Old cron service | Railway, `phoenix-cron` | offline, no use |
| **Production database, auth, storage and API** | **Supabase, project `ozucdzovmcqvepbozvqf`, eu-central-1 (Frankfurt)** | **Small: 2 shared cores, 2 GB RAM, 12 GB gp3 disk** |
| Staging database | Supabase, project `cifwmndunmlxjhyjugxa`, eu-central-1 | Micro |
| Scheduler | cron-job.org calling the app's cron routes, plus pg_cron inside the database | — |

The app runs in Railway's EU West region, which is Railway's own hardware in Amsterdam, and the database in AWS Frankfurt, so
every database call crosses between two European data centres. That round trip has not been measured from inside Railway; the
[benchmark plan](PHOENIX-MAXIMUM-PERFORMANCE-MINIMUM-COST.md#the-benchmark-plan) includes it.

## The app servers are nearly idle

Railway's own hourly metrics for the 7 days from 21 Oct 00:00 to 28 Oct 00:00 Cairo:

| Service | CPU, 7-day average | CPU, 10:00–18:00 Cairo | Highest hourly CPU | RAM, average | Highest hourly RAM | Egress, 7 days |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Web app | 0.073 vCPU | 0.124 vCPU | 0.219 vCPU | 1.89 GB | 6.37 GB | 28.7 GB |
| Worker | 0.010 vCPU | 0.011 vCPU | 0.036 vCPU | 1.06 GB | 6.05 GB | 2.5 GB |
| Device management | 0.002 vCPU | 0.002 vCPU | 0.015 vCPU | 1.10 GB | 2.49 GB | 1.0 GB |
| Its database | ~0 | ~0 | 0.001 vCPU | 0.10 GB | 0.15 GB | ~0 |

- **At the busiest hour of the week, the web app used about a fifth of one CPU core.** The worker used a thirtieth.
- The memory peaks above 3 GB (28 hours for the web app, 11 for the worker) were not traced to a cause in this audit. They
  are billed, and they stay far below the ceiling.
- **Nothing in the app tier is short of capacity.** Moving it, or giving it more, cannot make the database faster.

## The database server is the constraint

Detail and evidence: the [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md). In short, since the 25 Oct
16:14 Cairo boot (55.7 hours):

| Resource | Use | Verdict |
| --- | --- | --- |
| **Memory** | 4.3 GB database on a 2 GB machine; **≈ 7.0 GB swapped out**, 2.9 million major page faults | **Short** |
| CPU | 21.7 % average of 2 cores; no sign of throttling | Adequate for now |
| Disk | 1.4 % utilised, 26 IOPS of 3,000 | Idle |
| Connections | 19.6 s of pool waiting in total, 0 API pool timeouts | Healthy |

**Restarts:** 11 between 12 Oct and 25 Oct, every one in working hours (11:30–19:04 Cairo). None since 25 Oct 16:14, after
the load fixes that went live that night ([25 Oct baseline](../perf/2026-10-25-db-load-baseline.md)). A ~15-second stall
still happened on 27 Oct at 20:22.

## API volume

- **650,000–740,000 API requests on a weekday**; 1.64 million in the 55.7 hours since the boot.
- 89.5 % of the database's statement time comes from the server-side service role, not from browsers.
- Realtime: 0 messages. The project does not use it.

## How the app reaches the database

Read from the repository at `origin/main` on 28 Oct.

- **Every database read and write goes over HTTP through Supabase's API layer** (supabase-js to PostgREST). The app holds
  no direct Postgres connection; the `postgres` package appears only in scripts and tests. So every query is one API
  request, and the API layer's own cost per request lands on the database server's CPU.
- About 3,350 `.from(` calls and 230 `.rpc(` calls across the code read about 370 tables and 160 functions. Almost all of
  them use the server-side service-role client, which matches the 89.5 % service-role share in the database.
- Requests time out after 15 s. A gateway error is retried only on reads.
- **Caches are per process.** About 95 `unstable_cache` reads (mostly 5 minutes, some 1 hour), a 60-second shared-read
  cache with single-flight, and about 120 module-level maps. There is no Redis and no `cacheHandler`, so the Next.js data
  cache lives on the container's own disk. It is emptied by every deploy, and the website and the worker each keep their
  own copy.
- **Every open tab polls.** The pulse (badges, bell and heartbeat) runs every 30 s while the tab is visible and does
  eleven domain reads; some nav badges poll on their own every 30 s. Other screens poll every 10 s to 2 minutes. The share
  of the 650,000–740,000 weekday requests that comes from polling has not been measured; the
  [benchmark plan](PHOENIX-MAXIMUM-PERFORMANCE-MINIMUM-COST.md#the-benchmark-plan) includes it.
- Pages and API routes are dynamic (`force-dynamic` in nearly every page and route). Cloudflare holds the DNS only and does
  not proxy, so no CDN sits in front of the site.

## Scheduled and background work

| Where | What |
| --- | --- |
| **Inside the web and worker processes** | The worker runs the live CRM poller (every 20–120 s by time of day, with hourly, 3-hourly and daily syncs), CRM housekeeping (every 15 minutes) and a 60-second health line. |
| **cron-job.org** | 31 jobs calling the app's cron routes, from every 2 minutes (inbound intake) to weekly. About 20 nightly sweeps run between 03:00 and 08:00 Cairo. |
| **pg_cron in the database** | 8 jobs, among them the rep-entry-days reconcile every 5 minutes, two CRM reconciles every 15 minutes, hourly snapshots and nightly retention. |
| **GitHub Actions** | 7 scheduled drift and security checks, none touching the database's working tables. |

Heavy document work (Excel, PDF, Chromium rendering, OCR) runs inside the app's request handlers on Railway, which has
ample room for it. The only job queue is the `background_jobs` table.

## Monitoring today

- `/api/healthz` reports the running revision; `/api/readyz` checks the database with one small read.
- The `database_restarts`, `job_heartbeats` and `pg_stat_statements_snapshots` tables record restarts, scheduled-job health
  and statement statistics every 6 hours.
- **No script reads the database server's memory, swap or CPU.** The figures in this audit came from a manual read of the
  project's metrics endpoint. Stage 1 of the [roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md) is judged on those
  figures, so they are read the same way before and after.

## What this baseline already answers

1. **The slowness is on the database server, not the app servers.** The app uses a fifth of a core at peak; the database host
   swaps several gigabytes every working day.
2. **The database's shortage is memory, not CPU, disk or connections.**
3. **No amount of compute outside Supabase adds memory to the Supabase server.** What outside compute can do is covered in
   the [options document](PHOENIX-EXTERNAL-COMPUTE-OPTIONS.md).

## How to re-read it

- Railway: the project's Observability tab, or the `metrics` GraphQL query (CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB) per
  service for the production environment.
- Supabase: Project Settings → Compute and Disk for the size; Reports → Database for the memory and CPU charts; the
  re-read SQL at the end of the [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md#how-to-re-read-it).
