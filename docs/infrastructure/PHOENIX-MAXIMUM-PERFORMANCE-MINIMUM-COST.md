# Phoenix — maximum performance at minimum cost

The ten configurations the brief asked for, priced and compared on the same base. Prices are the official list prices read
on 28 Oct 2026 ([options document](PHOENIX-EXTERNAL-COMPUTE-OPTIONS.md)); the measurements are in the
[baseline](PHOENIX-INFRASTRUCTURE-BASELINE-AUDIT.md) and the [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md).
**Every performance figure for a configuration not yet running is a forecast**, and is labelled so. No benchmark was run;
the [benchmark plan](#the-benchmark-plan) says how each forecast is checked.

## Today's bill, the base for every row

| Item | A month | Basis |
| --- | ---: | --- |
| Supabase Pro plan | $25 | List price |
| Production compute, Small | $15 | List price |
| Staging compute, Micro | $10 | List price |
| Compute credit included in Pro | −$10 | Already used by the two sizes above |
| Production disk above the included 8 GB (12 GB) | $0.50 | 4 GB at $0.125 |
| **Supabase** | **≈ $40.50** | |
| Railway: workspace fee ($20, which includes $20 of usage) plus usage above it | **≈ $50** | Estimate from the usage read on 28 Oct; it moves month to month |
| **Total today** | **≈ $90** | |

**How double counting is avoided:**

- The Pro plan's $10 credit is counted once, here. Every Supabase step up therefore costs its full list difference.
- Railway's included $20 is already consumed by today's usage, so anything added on Railway is billed in full.
- A Redis service on Railway is priced as usage: a cache capped at 0.1–0.3 GB at $10 a GB-month is **$1–3 (estimate)**.
- Hetzner and the other providers are separate invoices, in their own currency; euros are converted at an **assumed
  1 EUR = 1.15 USD**.
- Rows 4 to 6 add a server beside today's Railway services. If the app moved onto it instead, see
  [Moving the app off Railway](#moving-the-app-off-railway-instead).

## The ten configurations

| # | Architecture | DB RAM | External RAM | CPU capacity | Total a month | Increment | Expected benefit | Complexity | Risk | Recommendation |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Current, unchanged | 2 GB | Railway pay-per-use (≈ 3 GB in use on average, none short) | Database: 2 shared cores, 21.7 % used. App: 0.12 vCPU used in working hours | ≈ $90 | — | None. The database keeps swapping (≈ 7 GB in 55 hours). | None | **High:** afternoon stalls; 11 working-hours restarts in the 14 days to 25 Oct | No |
| 2 | Current + database optimisations (roadmap 2a, 2b, 2c, 2e) | 2 GB | as 1 | as 1 | ≈ $90 | $0 | Forecast: the top two CRM read shapes touch at least 50 % fewer pages; at least 20 % fewer API requests a weekday. Adds no memory. | Medium: four pull requests | Low to medium: each must return the same rows, which its acceptance checks | **Yes, in every architecture** |
| 3 | Current + Redis (inside Railway) | 2 GB | ≈ 0.25 GB cache | as 1 | ≈ $91–93 | +$1–3 (estimate) | The data cache survives deploys, and the web app and worker share one copy. Forecast: cached heavy reads per working day down at least 50 %. | Low to medium: one cache handler, plus a review of keys | Low, while every key carries the caller's access scope | **Yes (roadmap 2d)** |
| 4 | Current + Hetzner 8 GB (CX33) | 2 GB | 8 GB, 4 shared vCPU | Database unchanged; the new capacity sits idle | ≈ $100 | +€8.99 ≈ +$10.34 (with IPv4) | None for the database. | Medium: a server to deploy, patch and secure | Medium: a new data processor; servers "currently unavailable" on 28 Oct | No |
| 5 | Current + Hetzner 16 GB (CX43) | 2 GB | 16 GB, 8 shared vCPU | as 4 | ≈ $109 | +€16.49 ≈ +$18.96 (with IPv4) | None for the database. | Medium | Medium, as 4 | No |
| 6 | Current + Hetzner 8 GB + Redis run on it | 2 GB | 8 GB | as 4 | ≈ $100 | +€8.99 ≈ +$10.34 | The cache gain of row 3, with the cache across the public internet. | High: TLS, firewall, patching and backups for a cache | Medium to high: employee data cached with a new processor | No: row 3 does the same inside Railway |
| 7 | Current + Cloudflare proxy | 2 GB | none | as 1 | ≈ $90 (Free) to ≈ $115 (Pro, monthly) | $0 to +$25 | Static files served from the edge; less than $6 a month of Railway egress saved. The database is untouched. | Low to medium | Medium: one wrong cache rule serves one person's page to another | Not now |
| 8 | Supabase compute upgrade: **Medium** | **4 GB** | none | Database: 2 shared cores | **≈ $135** | **+$45** | The one change that adds database memory. Forecast: swapping stops or falls sharply, and the stalls and restarts with it. | Low: one click, one restart | Low: reversible by the hour; the restart usually takes under 2 minutes | **Yes, first** |
| 8b | Supabase upgrade: Large, or XL | 8 GB, or 16 GB | none | 2, or 4, dedicated cores | ≈ $185, or ≈ $285 | +$95, or +$195 | All of the data fits in memory; the cores are not shared. No measured need yet. | Low | Low | Only if Medium's numbers ask |
| 9 | Supabase read replica (Small) | 2 GB primary + 2 GB replica | none | 2 + 2 shared cores | ≈ $107–111 | +$17 to +$21 | GET reads can move to the replica. Function calls (POST by default), writes and Auth stay on the swapping primary. | Medium to high: every read-after-save path reviewed for replica lag | Medium: a screen can miss its own save | Not now |
| 10 | **Best alternative found: Medium + Redis inside Railway + roadmap Stage 2** | **4 GB** | ≈ 0.25 GB cache | Database: 2 shared cores | **≈ $136–138** | **+$46–48** | Memory added, the work per page cut, and the cache kept across deploys. | Medium, spread over separate pull requests | Low | **Recommended** |

The cheapest row that addresses the measured cause is 8; the best per dollar is 10, which costs $1–3 more than 8 and lowers
the load that would otherwise grow back into the 4 GB.

## Moving the app off Railway instead

The brief's "Hetzner instead of a Supabase upgrade" question also covers moving the web app and worker to a cheaper server.

- Railway would still bill its $20 workspace fee for the device-management service, so moving the app saves at most the
  usage above it: about $30 a month (estimate).
- A CX43 (16 GB) with IPv4 costs €16.49 ≈ $18.96. **Net saving: about $11 a month.**
- In exchange: a new data processor holding the service-role key, a server to patch, back up and secure, and a deploy path
  that has to reproduce today's release gate and zero-downtime switch. **No page gets faster**: the database is the same.

Not recommended.

## Performance comparison

**Every cell after the first column of figures is a forecast**, written as a direction, not a number. Where today's figure
was not measured, the cell says so; the [benchmark plan](#the-benchmark-plan) measures it before any change.

| Measure | 1 Today (measured) | 2 Optimise | 3 Redis | 4–6 External server | 7 Cloudflare | 8 Medium | 9 Replica | 10 Recommended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Median response time | Not measured | Lower on CRM screens | Lower after deploys | Unchanged | Unchanged for pages | Lower where reads hit swapped pages | Unchanged | Lower |
| P95 response time | Not measured; the slow tail includes swap stalls | Lower | Lower after deploys | Unchanged | Unchanged | **Much lower** | Unchanged for writes and function calls | **Much lower** |
| P99 response time | Not measured; includes stalls of seconds (≈ 15 s on 27 Oct) | Somewhat lower | Unchanged | Unchanged | Unchanged | **Much lower** if the stalls stop | Unchanged | **Much lower** |
| Database CPU | 21.7 % of 2 cores | Lower | Lower | Unchanged | Unchanged | Similar; less time spent paging | Primary somewhat lower | Lower |
| Memory pressure | ≈ 7 GB swapped out and 2.9 M major faults in 55 hours | Somewhat lower | Somewhat lower | Unchanged | Unchanged | **Much lower** | Unchanged on the primary | **Lowest of the affordable rows** |
| Connections | Healthy: 0 API pool timeouts | Healthy | Healthy | Healthy | Healthy | Healthy; limits 90 → 120 direct, 400 → 600 pooler | Healthy | Healthy |
| Peak users | Not measured | Higher ceiling | Higher ceiling | Unchanged | Unchanged | Higher ceiling | Slightly higher | Highest of the affordable rows |
| Job throughput | Not measured; the worker idles at 0.01 vCPU | Faster where a job's SQL is the heavy part | Unchanged | Unchanged: same database | Unchanged | Faster | Unchanged | Faster |
| Reporting speed | Sales against target: 307 ms a call on average | Unchanged unless the report is in scope | Fewer repeat calls after deploys | Unchanged | Unchanged | Faster | Possibly faster, only if the read becomes a GET | Faster |
| Dashboard load | Every open tab makes eleven reads every 30 s | **One read instead of eleven** (2e) | Unchanged | Unchanged | Unchanged | Faster reads | Unchanged | One read, faster |
| Scalability | Held by 2 GB of database memory | Slows the growth | Slows the growth | None for the database | None | Twice the memory; Large or XL by the hour | A second 2 GB machine for GET reads | Best of the affordable rows |
| Recovery | A restart takes the app down for minutes | Unchanged | Redis down means slower, not down | Adds a server that can fail on its own | Adds an edge layer | Unchanged; restarts rarer | Adds a machine to watch | Restarts rarer |
| Complexity | Today's | Medium | Low to medium | Medium to high | Low to medium | Low | Medium to high | Medium |

## The benchmark plan

Read-only, reproducible, and nothing provisioned. Every "before" is read on the same weekdays and hours as its "after".

### What is measured, and where

| Measure | Source | How |
| --- | --- | --- |
| Median, P95 and P99 response time per page and API route | Railway's HTTP logs for the web service | One working day, 10:00–18:00 Cairo; group by route; compute the three percentiles |
| Round trip from the app (Amsterdam) to the database (Frankfurt) | The duration of `/api/readyz` in the same logs (it does one small database read) | Median and P95 over the day |
| Database memory, swap, major faults, CPU and steal | The project's metrics endpoint | Read every 5 minutes by a server-side script holding the credential; never a browser. Rates per working hour |
| Statement cost: calls, mean time, pages touched and read per call | `pg_stat_statements`, already saved every 6 hours in `pg_stat_statements_snapshots` | The difference between the snapshots that bracket the window |
| Restarts and stalls | `public.database_restarts`; the Postgres log for statements over 5 s | Count per window |
| API requests per weekday, and the share that is polling | Supabase API logs | Count by path; the pulse's eleven reads are known paths |
| Peak users | The pulse's heartbeat | Distinct signed-in users per hour |
| Job throughput | `background_jobs` and `job_heartbeats` | Jobs finished per hour; wait from queued to started |
| Reporting speed and dashboard load | The route percentiles above | The sales-against-target and dashboard routes, read on their own |

### Rules

- **No `EXPLAIN ANALYZE` on production without the owner's approval.** A plan is read with plain `EXPLAIN`, which does not
  run the query. When a timed plan is needed, it runs on staging first, and on production only with his word, outside
  working hours.
- **No synthetic load test against production.** Real traffic is the load; a load test would push the 2 GB machine into
  swap during the working day.
- **One change at a time**, each with its own before and after, so each gain has one cause. Deploy days are noted, because a
  deploy empties today's cache.
- **Five working days before and after** each infrastructure change; one working day before and after each code change.
- A figure that could not be read is reported as not read, never as zero.
- No credential or employee record goes into the results.

### Pass marks

The acceptance numbers for each stage are in the [roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md): for Medium,
under 10 MB swapped an hour in working hours, major faults down at least 80 %, no restarts and no stall over 5 s.
