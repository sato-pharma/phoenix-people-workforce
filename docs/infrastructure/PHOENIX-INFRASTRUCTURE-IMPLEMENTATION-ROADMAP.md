# Phoenix — infrastructure implementation roadmap

Three stages, in order, for the [recommended architecture](PHOENIX-RECOMMENDED-ARCHITECTURE.md). **Nothing here has been
started.** Each stage begins only on the owner's word. The compute change in Stage 1 is his own click on the Supabase screen;
it is never made from chat or by a script. Every code or database change in Stage 2 goes through its own pull request.

Prices are the official list prices read on 28 Oct 2026 ([options document](PHOENIX-EXTERNAL-COMPUTE-OPTIONS.md)). Supabase
bills compute by the hour, so a stage that is rolled back costs only the hours it ran.

## How this follows the brief's three stages

The brief orders the work free first, low-cost second, and a Supabase upgrade last, bought only if the earlier stages cannot
meet the measured need. **The measurements already answer that for one resource, memory.** No code change can shrink the
640 MB of shared buffers or the platform services that share the 2 GB machine, and the machine swapped about 7 GB in the
55 hours after the 25 Oct fixes. So the single memory step is brought forward:

| Brief's stage | Here | Spend |
| --- | --- | --- |
| Stage 1 — free optimisations | **Stage 2**, items 2a, 2b, 2c and 2e | $0 |
| Stage 2 — low-cost capacity | **Stage 1** (Medium, the one step that adds memory) and item **2d** (a cache service in Railway) | +$45, plus a few dollars |
| Stage 3 — targeted scaling | **Stage 3**: Large, XL or a read replica, only if the numbers ask | +$95 or more |

Anyone who wants the brief's order strictly takes [architecture A](PHOENIX-RECOMMENDED-ARCHITECTURE.md#a--lowest-cost-stay-on-small-take-load-off):
Stage 2 first, and Medium only if the afternoon swapping continues. The cost of waiting is the risk of another working-hours
restart.

## Stage 1 — give the database server room: Small → Medium

| | |
| --- | --- |
| **Change** | Supabase → Project Settings → Compute and Disk → Medium (4 GB RAM, shared CPU). Production only; staging stays Micro. |
| **Cost** | **+$45 a month** ($15 → $60), billed hourly ($0.0206 → $0.0822 an hour): about $1.50 a day. A part hour is billed as a full hour. |
| **When** | After 22:00 Cairo on a working day, when the API traffic is lowest. |
| **Interruption** | The database restarts once to change size. Supabase's documentation says this usually takes under 2 minutes and can take longer; the app answers errors meanwhile. Plan it like any other restart. |
| **Who** | The owner, on the Supabase screen. |

**Acceptance — read after five working days, compared as rates since the boot, the same way as the
[PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md):**

| Measure | Today (Small) | Pass |
| --- | --- | --- |
| Swapped out per working hour (10:00–18:00 Cairo) | ≈ 125 MB an hour averaged over the whole day, most of it in working hours | **under 10 MB an hour** |
| Major page faults per hour | ≈ 52,000 | **down at least 80 %** |
| Restarts (`public.database_restarts`) | 11 in the 14 days to 25 Oct | **0** |
| API statement timeouts and stalls over 5 s in the logs | a ~15 s stall on 27 Oct | **none** |
| CPU steal | 0.55 % | **under 2 %** — Medium still runs on shared CPU |
| Mean time of the top 10 statements | the 25 Oct baseline | **no worse; expected better** |

**Rollback:** the same screen, back to Small. One more restart; billing stops within the hour. Roll back if CPU steal stays
above 5 % in working hours, or if the swap rate does not fall. Either would mean memory was not the whole story, and the
[Stage 3 decision](#stage-3--only-if-the-evidence-asks-for-it) is read instead.

## Stage 2 — take load off the database: no new spend, one pull request each

These pay off at any compute size, and they slow the database's growth back towards the edge. Each is a separate change
with its own owner approval. None moves employee data to a new provider.

| # | Change | Expected effect (forecast, not measured) | Acceptance |
| --- | --- | --- | --- |
| 2a | The three CRM "unified" views and the contact-assignment reads walk far fewer pages: narrower view bodies, a covering index only where a measured plan needs it. | These are a third of the database's time and touch well over 2 TB of in-memory pages in 55 hours. | Pages touched per call down at least 50 % on the top two shapes, the same rows returned. |
| 2b | The import-row search stops reading the whole table from disk: a search column or a narrower filter, decided after an approved `EXPLAIN`. | The one load that reads from disk: 11.2 GB in 55 hours. | Disk reads for that statement down at least 90 %. |
| 2c | Finish the touch-trail retention already in progress (30 days, archived nightly to a private bucket). After a month of index counters and a code search, decide on the 233 MB index nobody has read since the boot. | Caps the biggest table at about a month of rows. | Table size flat week on week. |
| 2d | **The app's data cache survives a deploy.** Move the Next.js cache from the container's disk to a small Redis service inside the same Railway project and region, on Railway's private network. | There were 116 deploys in two days; each one emptied the cache and re-ran the heavy reads. | Calls to `phx_sales_vs_target_range` and similar cached reads per working day down at least 50 %. |
| 2e | Fewer API requests: the sign-in bundle, now read about 250,000 times in 55 hours (about 15 % of all API requests), kept briefly per session; the 30-second pulse's eleven reads folded into one; one batched read where a page now makes several. | The API layer's per-request cost is most of the server's CPU. | Weekday API requests down at least 20 % from 650,000–740,000, with a role change or a disabled account still taking effect within the cache's lifetime. |

**Data protection, 2d:** the cache already holds the same data today, on Railway's disk. A Redis service in the same Railway
project keeps it with the same provider, in the same region, on a private network with no public address. It is reached
only from the server; the service-role key never reaches a browser. **Every cache key keeps the caller's access scope**,
exactly as the [26 Oct cache audit](../production-audits/cache-audit-2026-10-26.md) requires, so a cached answer can never
reach someone the live read would refuse. A cache with a third party outside Railway would be a new data processor and is
not proposed.

**Rollback:** each change reverts with its own pull request. The cache in 2d falls back to the container's disk if the
Redis service is removed. That is today's behaviour, so the app keeps working, only slower after a deploy.

## Stage 3 — only if the evidence asks for it

Read Stage 1's numbers after five working days, and again a month later.

| What the numbers show | Then | Extra cost over today |
| --- | --- | --- |
| Swapping has stopped, no restarts, steal low | **Stay on Medium.** Stage 2 continues. Nothing more to buy. | +$45 |
| Swapping has stopped but CPU steal is high in working hours | **Large** (8 GB, 2 dedicated cores): the first size whose CPU is not shared. | +$95 |
| Swapping continues on Medium | **Large**, and re-read what is using the memory. | +$95 |
| The database outgrows 8 GB, or reports need to be isolated from the working day | **XL** (16 GB, 4 dedicated cores), or a Supabase read replica for reports. Price both from the official page at that time. | +$195 or more |

**Rollback** is the same screen, one size down, at the cost of one restart.

## What is deliberately not on this roadmap

- **Moving the database.** Supabase stays the authoritative database (the brief).
- **A self-managed copy of the database on another provider.** It would put employee records with a new data processor,
  needs replication that can fill the production disk if the copy stops, and is more machinery than one owner should run.
  See the [options document](PHOENIX-EXTERNAL-COMPUTE-OPTIONS.md).
- **Moving the app off Railway.** The app tier uses a fifth of a core at peak; a cheaper host would save a few dollars and
  make nothing faster.
- **Disk IOPS or throughput.** The disk is 1.4 % utilised.
- **Dropping indexes because their counters read zero, or adding all 36 advisor foreign-key indexes.** See the
  [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md#finding-8--what-the-advisors-say-and-what-not-to-do-with-it).
