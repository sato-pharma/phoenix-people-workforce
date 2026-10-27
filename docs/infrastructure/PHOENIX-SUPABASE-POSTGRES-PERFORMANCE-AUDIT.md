# Phoenix — Supabase PostgreSQL performance audit

> **Corrected on 28 Oct 2026 by the [final validation](PHOENIX-FINAL-INFRASTRUCTURE-DECISION-VALIDATION.md)**, which decides to keep Small and optimise (Decision A). Where this report and the validation differ, the validation is right.

Read from production (`ozucdzovmcqvepbozvqf`) between **27 Oct 2026 23:55 and 28 Oct 00:25 Cairo**. Every figure covers the
time since the database last started, on **25 Oct at 16:14 Cairo**: 55.7 hours, including two full working days (26 and 27 Oct).

Sources: the project's own metrics endpoint, `pg_stat_statements`, `pg_stat_database`, `pg_stat_user_tables`, the Supabase
Management API and the Supabase advisors. Nothing was changed. No `EXPLAIN ANALYZE` was run, because the brief asks for
approval first; the [benchmark plan](PHOENIX-MAXIMUM-PERFORMANCE-MINIMUM-COST.md#the-benchmark-plan) says what would be timed.

Earlier reads this builds on, not repeated here: [the 25 Oct load baseline](../perf/2026-10-25-db-load-baseline.md) and the
fixes that went live that night, and [the 26 Oct cache audit](../production-audits/cache-audit-2026-10-26.md).

## The box

| Item | Value |
| --- | --- |
| Compute size | **Small**: 2 shared cores, 2 GB of RAM (1.93 GiB visible to the operating system) |
| Disk | gp3, 12 GB provisioned, 5.79 GB used, 3,000 IOPS provisioned |
| Database size | 4,309 MB, of which `public` is 3,952 MB and the backup schemas about 150 MB |
| `shared_buffers` | 512 MB |
| `work_mem` | 32 MB |
| `max_connections` | 200 |
| Parallel workers per query | 2 |
| JIT | off |
| `statement_timeout` | 120 s |
| `track_planning` | off, so planning time is not in the statement totals |

**The database is more than twice the size of the machine's memory.** It also shares those 2 GB with Supabase's own services
on the same host: the API layer, the connection pooler, auth and logging.

## Finding 1 — the machine is short of memory, and that is the main cause of the stalls

| Measure since 25 Oct 16:14 | Value | What it means |
| --- | --- | --- |
| Memory still available at the read | 605 MB | at midnight, the quietest hour |
| Swap in use | 208 MB of 1.07 GB | |
| Written out to swap | **≈ 7.0 GB** | about 125 MB an hour, and most of it during the working day |
| Read back from swap | ≈ 4.1 GB | |
| Major page faults | **2.9 million** | each one is a wait for the disk |
| Reads from the system disk, where swap lives | 62.5 GB | more than the data disk's reads |
| Out-of-memory kills | 0 | |

The 27 Oct read (`the-afternoon-stalls-are-the-2gb-box-swapping-under-daytime-load` in memory) measured about 530 MB swapped
out in the first 7 quiet hours after the boot. By the next evening it was 6.6 GB. **The swapping follows the working day.**

The restart log (`public.database_restarts`) began on 12 Oct and lists 11 entries, every one in working hours. **Postgres's own log
confirms 9 of them as crash restarts between 11 and 25 Oct** (10 counting 10 Oct 11:05); the 20 Oct 14:11, 22 Oct 11:30 and
22 Oct 12:33 entries have no crash-recovery line, so what the table caught there is not known:

> 12 Oct 19:04 · 14 Oct 11:34 · 17 Oct 12:30 · 18 Oct 11:54 · 19 Oct 13:51 · 20 Oct 14:11 · 22 Oct 11:30, 11:51, 12:33,
> 14:25 · 25 Oct 16:14

There has been **none since 25 Oct 16:14**. That covers two working days, after the load fixes that went live on 25 Oct at
23:54 Cairo. A ~15-second stall still happened on 27 Oct at 20:22. **The code fixes moved the box back from the edge. They
did not give it room.** Postgres alone has 512 MB of shared buffers and the platform services' fixed memory on top; no code
change can shrink the services' share.

## Finding 2 — the CPU is busy but not saturated

| Measure since boot | Value |
| --- | --- |
| Average busy, both cores | **about 20 %** (14.6 % at night) |
| User time | 20.2 % |
| Waiting for disk (iowait) | 0.48 % |
| Taken by the hypervisor (steal) | 0.55 %, 2,218 s in total |

- **SQL is about one sixth of the CPU.** Postgres spent 13,880 s in active statements (11,218 s of execution in
  `pg_stat_statements`), against 80,846 s of user CPU on the host. The rest belongs to the services beside Postgres; auth
  used only 349 s of it. The metrics available from inside the project cannot split the rest by process.
- The API layer did **1.64 million requests** in 55.7 hours (650,000–740,000 on a weekday). Each one runs `set_config` once
  to carry the caller's identity, and its token cache hit only 573 times. That per-request cost is the platform's, not a
  query's, and **only fewer requests reduce it**.
- Small runs on **shared CPU**, as do Micro and Medium; Large and above have dedicated cores. Supabase publishes no CPU
  baseline for the shared sizes: its "burst" figures are for the disk. Time taken by neighbours on a shared host shows as
  steal, and 0.55 % shows **no sign that the CPU was held back** in these 55 hours.

## Finding 3 — the disk is idle; buying IOPS or throughput would change nothing

| Data disk, since boot | Value |
| --- | --- |
| Read | 80.8 GB |
| Written | 41.4 GB |
| Average read rate | 0.40 MB/s |
| Average utilisation | **1.4 %** |
| Average IOPS | **26**, of 3,000 provisioned |

The buffer hit ratio is **99.04 %**. Only 12 temporary files (149 MB) spilled to disk. **The workload is CPU spent walking
pages that are already in memory, plus swapping, not disk reads.** A disk upgrade is the wrong lever.

## Finding 4 — where the database's own time goes

Share of total statement time since the boot (3.41 million calls, 11,218 s):

| Object read | Share of time | Buffer pages touched |
| --- | ---: | ---: |
| `crm_visits_unified` | 13.9 % | ≈ 979 GB |
| `crm_plan_entries_unified` | 8.8 % | ≈ 384 GB |
| `crm_contact_assignments` | 6.7 % | ≈ 1,032 GB, about 240 MB a call on one query shape |
| `source_of_sales_import_rows` | 5.1 % | 11.2 GB **read from disk** |
| `crm_checkins_unified` | 4.6 % | |
| `crm_contact_master_refresh()` | 4.4 % | 1.1 s per call |
| `phx_sales_vs_target_range()` | 3.5 % | 308 ms per call |
| `employees` | 3.0 % | 122,000 calls |

**When:** the 6-hourly statement snapshots (`public.pg_stat_statements_snapshots`, the top ~100 statements, about 70 % of
all statement time) show the load by time of day:

| Window, Cairo | 26 Oct: statement time | 26 Oct: pages read into the buffer pool | 27 Oct: statement time | 27 Oct: pages read into the buffer pool |
| --- | ---: | ---: | ---: | ---: |
| 00:17–06:17 | 303 s | 2.4 GB | 177 s | 0.2 GB |
| 06:17–12:17 | 898 s | 4.4 GB | 520 s | 2.1 GB |
| **12:17–18:17** | **1,395 s** | **7.6 GB** | **1,220 s** | **7.4 GB** |
| 18:17–00:17 | 702 s | 2.8 GB | 1,158 s | 1.0 GB |

The early afternoon carries **four to seven times the night's work**, and the pages the buffer pool has to fetch again
rise more than threefold. Every logged restart fell between 11:30 and 19:04 Cairo, around this window.

- **The service role does 89.5 % of the work.** That is the server-side app, not browsers.
- **The three CRM "unified" views and the contact assignments are a third of the database's time.** They walk well over two
  terabytes of in-memory pages in 55 hours, about 44 GB an hour. That is the clearest code-side lever in the system. The
  25 Oct baseline left the check-in view alone on purpose, for its own pass.
- `source_of_sales_import_rows` is searched with a leading wildcard (`ilike '%…%'`), which an ordinary index cannot answer.
  It is the one load here that reads from disk: 11.2 GB.
- The hourly contact-list refresh already skips an unchanged tick (migration `20261027174307`, applied 27 Oct).
- **Deploys empty the app's cache.** There were 116 merges between 25 Oct 16:14 and the 27 Oct evening read, a median gap
  of 8 minutes. Each deploy starts with an empty Next.js data cache, so `phx_sales_vs_target_range` and similar reads are
  re-run after every release even though they are cached for an hour.

## Finding 5 — the biggest table is written constantly and almost never read

`phoenix_crm_touch_trail` is **991 MB** (heap 539 MB, indexes 452 MB). It took about 280,000 inserts in 55.7 hours. Since the
boot it was read 4 times by sequential scan and 5 times by index.

- Every insert updates every index on it, so the table keeps dirtying pages in a buffer pool that the hot CRM reads need.
- Its index `phoenix_crm_touch_trail_session_idx` is 233 MB with **0 scans since the boot**. That is a counter over 2.3 days
  and is **not a case for dropping it**. A rarely used index can still serve a monthly report or an investigation; it needs
  a code search for every reader first.
- A 30-day retention with nightly archiving to a private storage bucket is already in progress in another branch
  (`codex/db-load-cut`, first real delete around 2 Nov). That caps the size. It does not reduce the insert rate.

## Finding 6 — connections are healthy; a bigger pool would change nothing

- The pooler's clients waited **19.6 s in total** over 55.7 hours.
- The API layer's pool is 30 connections and recorded **0 timeouts**.
- Auth is capped at **10 database connections**. The advisor warns that this cap does not grow with the compute size; it
  becomes a percentage setting only if auth starts queueing, and nothing here shows that.
- **Sessions sat idle inside an open transaction for 18,829 s in total.** A 60-second `idle_in_transaction_session_timeout`
  is already set, so no single session holds one open for long: this is several hundred short waits, not one stuck session.
  At the read on 28 Oct 00:35 Cairo the oldest open transaction was under a second old. No change is proposed.

## Finding 7 — scheduled jobs are light and healthy

| Job | Schedule | Cost |
| --- | --- | --- |
| rep-entry-days reconcile | every 5 minutes | about 0.3 s a run, 154 s in 48 hours |
| CRM agent ids reconcile | hourly | up to 10 s a run |
| recovery snapshot | hourly | about 1.7 s a run |

None failed in the last 48 hours.

## Finding 8 — what the advisors say, and what not to do with it

| Advisor | Count | Verdict |
| --- | ---: | --- |
| Foreign keys with no covering index | 36 | **Not a to-do list.** An index costs memory and write time on a box short of both. Add one only where a real query or a cascading delete is slow. |
| Unused indexes | 644 | **Not a delete list.** The counters cover 2.3 days. A drop needs a code search for every reader and a month of counters. |
| Tables without a primary key | 703 | Mostly the backup schemas, which are copies, not working tables. No action. |
| Tables with more than one permissive policy | 2 | `daily_deductions_lines` and `deductions_publication_lines`. Each policy is evaluated per row. They are small today; merging the policies is an access-control change and needs its own review. |

## Finding 9 — vacuum, locks and sorts are healthy

Read on 28 Oct at 00:35 Cairo.

- **No table above 5,000 rows has more than 20 % dead rows.** The highest are the Source of Sales roll-ups at 13 %, cleaned
  at 03:20 on 27 Oct by the nightly rebuild's own vacuum. Autovacuum runs with the platform's defaults (3 workers, 60 s,
  20 % scale factor) and is keeping up.
- The touch trail has 2.3 million rows and almost no dead ones: it is only ever added to (Finding 5).
- **0 lock waits, 0 deadlocks** since the boot. At the read, 11 sessions were idle and 1 was active.
- **12 temporary files** since the boot. Sorts and hashes fit in `work_mem`.

Locks, bloat and vacuum are not where the time goes.

## The ranked opportunities

The brief's table. Calls, average and total are from `pg_stat_statements` since the boot, read on 28 Oct at 00:35 Cairo.
**Every "expected improvement" is a forecast**: no `EXPLAIN ANALYZE` was run, and each fix is proved by its own acceptance
number in the [roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md). Ranked by benefit for the effort.

| # | Query / function | Calls | Average | Total | Root cause | Proposed fix | Expected improvement (forecast) | Risk |
| ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | `crm_contact_assignments`, one read shape | 2,371 | 222 ms | 527 s | Walks about 30,000 in-memory pages, roughly 230 MB, per call. **Every call came before the roster cache went live on 26 Oct 00:09; none since, so it is no longer a target** | A narrower filter, and an index only where an approved plan shows it is used | Page walks down by half or more on this shape | Medium: CRM visibility rules must return the same rows |
| 2 | `crm_visits_unified` | 12,527 | 39 ms | 487 s | A view over five visit sources with 11 joins, evaluated on every read; 43 million pages walked | Read only the columns and sources the screen needs | Page walks down by half on the top shape | Medium: same as 1 |
| 3 | `crm_plan_entries_unified`, two shapes | 4,209 | 186–214 ms | 832 s | A view over two plan sources with 5 joins; 41 million pages walked | As 2 | As 2 | Medium |
| 4 | `phx_sales_vs_target_range` and its cache token | 3,027 | 307 ms and 54 ms | 488 s | Cached for an hour, but the cache lives on the container's disk and **every go-live empties it**: 116 merges in two days, 27 go-lives on 27 Oct | A data cache that survives a deploy, in the same Railway project | Calls down by half or more on deploy-heavy days | Low: the numbers already come from the closing engine; only the cache's home changes |
| 5 | `phx_auth_session_bundle` | 249,985 | 0.4 ms | 104 s | Cheap in SQL, but about **15 % of all API requests**, and each request pays the API layer's own cost on the database server | Keep the bundle in the server's memory for a short time per signed-in session | API requests down by up to a tenth | **Medium: sign-in and access.** A role change or a disabled account must still take effect within the cache's lifetime; needs its own review |
| 6 | `source_of_sales_import_rows` search, two shapes | 6,554 | 50–98 ms | 447 s | `ilike '%…%'` cannot use an ordinary index, so the table is read; **1.1 million pages from disk** | A search column or a narrower filter, chosen after an approved `EXPLAIN` | Disk reads for these shapes down by 90 % | Low |
| 7 | `crm_contact_master_refresh()` | 431 | 1,141 ms | 492 s | Rebuilds the whole contact list; 406,000 pages from disk | Already skips an unchanged tick (27 Oct). Next: refresh only the contacts that changed | Calls or pages down by half | Medium: the contact list feeds every CRM screen |
| 8 | `phoenix_crm_seat_readiness` | 839 | 265 ms | 222 s | 12.8 million pages walked | Review together with 1–3; it reads the same CRM tables | Follows 1–3 | Medium |
| 9 | `crm_checkins_unified` | 8,496 | 31 ms | 265 s | 232,000 pages from disk | As 2; the 25 Oct work left this view for its own pass | As 2 | Medium |
| 10 | `phoenix_crm_ensure_reference_customers` | 5,726 | 25 ms | 144 s | An "ensure" function called thousands of times; whether each call needs to run was not traced | Find the callers; call it only when the input changed | Unknown until the callers are read | Low |
| 11 | `phoenix_crm_rep_entry_days_reconcile_run()`, scheduled every 5 minutes | 676 | 264 ms | 178 s | Re-checks the same days each run | None now: it is light and protects the data | — | — |

Together rows 1–3 and 7–9 are **about a third of all statement time**. Rows 4 and 5 are the cheapest: neither changes a query.

## What this rules in and out

| Lever | Verdict | Why |
| --- | --- | --- |
| More RAM on the database host | **Needed** | Proven by the swap and fault counters (Finding 1). |
| More or dedicated CPU | **Not needed now** | About 20 % average, no sign of throttling (Finding 2). |
| More disk IOPS or throughput | **Not needed** | 1.4 % utilised (Finding 3). |
| A bigger connection pool | **Not needed** | 19.6 s of waiting in 55.7 hours (Finding 6). |
| Fewer page walks in the CRM views | **Worth doing at any size** | A third of the database's time (Finding 4). |
| A cache that survives deploys | **Worth doing at any size** | 116 cold starts in two days (Finding 4). |
| Fewer API requests per page | **Worth doing at any size** | The platform's per-request cost is most of the CPU (Finding 2). |

## How to re-read it

Compare rates since the boot, never raw totals: a restart resets them.

```sql
select now() at time zone 'Africa/Cairo' as cairo_now,
  pg_postmaster_start_time() at time zone 'Africa/Cairo' as boot_cairo,
  (select count(*) from public.database_restarts
     where postmaster_start_at > now() - interval '14 days') as restarts_14d,
  (select round(sum(total_exec_time) / 1000) from pg_stat_statements) as statement_seconds,
  (select sum(calls) from pg_stat_statements) as calls;
```

Swap, faults and CPU come from the project's metrics endpoint (`/customer/v1/privileged/metrics`, service-role basic auth,
server-side only): `node_vmstat_pswpout`, `node_vmstat_pgmajfault` and `node_cpu_seconds_total`.
