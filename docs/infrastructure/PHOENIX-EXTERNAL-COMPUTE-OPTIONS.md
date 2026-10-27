# Phoenix — external compute options

> **Corrected on 28 Oct 2026 by the [final validation](PHOENIX-FINAL-INFRASTRUCTURE-DECISION-VALIDATION.md)**, which decides to keep Small and optimise (Decision A). Where this report and the validation differ, the validation is right.

Every option the brief named, A to I, weighed against what was measured: **the Supabase database server is short of
memory, and the app servers are nearly idle** ([baseline](PHOENIX-INFRASTRUCTURE-BASELINE-AUDIT.md),
[PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md)). Prices are official list prices, read on 28 Oct 2026
from the pages linked in [Sources](#sources). No provider is favoured; each is judged on what it can do for this workload.

## The question first: can 8, 16 or 32 GB outside Supabase cost less than a Supabase upgrade?

The brief asks for three separate answers, and they differ.

| Capacity of… | Can external compute supply it? | Cheapest way to add it |
| --- | --- | --- |
| **1. PostgreSQL itself** (memory and CPU of the database server) | **No.** Memory on another machine never becomes the Supabase server's memory. Only a Supabase compute size changes it. | Supabase Medium, +$45 a month for +2 GB |
| **2. The app as a whole** (web, worker, jobs) | Yes, and cheaply: an 8–32 GB server costs a fraction of a Supabase upgrade. **But the app tier uses a fifth of one core at peak**, so the extra capacity would sit idle. | Nothing to buy |
| **3. The database's effective workload** (work the database no longer has to do) | **Partly.** A cache can answer repeated reads instead of the database. A copy of the database on another server could take reads, at a cost in risk and data protection (option H). | A small cache inside the Railway project |

**So the plain answer:** external RAM is cheaper per gigabyte than Supabase RAM, but it is the wrong kind of RAM for the
measured problem. Every option below is judged on that.

## How the prices are stated

- **Euro prices are converted at an assumed 1 EUR = 1.15 USD**, for comparison only. It is not a quoted rate; the euro
  figure is the price.
- Prices exclude VAT. Hetzner invoices customers outside the EU without VAT. How Egyptian tax treats a foreign cloud
  invoice is not assessed here; it would apply equally to the Supabase and Railway invoices already paid.
- A month is 730 hours wherever a provider bills by the hour.
- "Not verified" means the page could not be read down to the plan and the figure is not used in any decision.

## A — Supabase compute

| Size | RAM | CPU | A month | Over today's Small |
| --- | ---: | --- | ---: | ---: |
| Micro | 1 GB | shared | $10 | −$5 |
| **Small (today)** | **2 GB** | **shared** | **$15** | — |
| Medium | 4 GB | shared | $60 | **+$45** |
| Large | 8 GB | 2 dedicated cores | $110 | +$95 |
| XL | 16 GB | 4 dedicated cores | $210 | +$195 |
| 2XL | 32 GB | dedicated | $410 | +$395 |

- **Billing:** by the hour (Small $0.0206, Medium $0.0822); a part hour is billed as a full hour. The Pro plan's $10
  compute credit is already used by today's production and staging sizes, so every step up costs the full difference.
- **Changing size** restarts the database once; Supabase's documentation says this usually takes under 2 minutes.
- **Connections:** Small allows 90 direct connections and 400 pooler clients, Medium 120 and 600. Phoenix reaches the
  database through the API layer and has had 0 pool timeouts, so connections are not the limit at either size.
- **Disk throughput:** Small 22–261 MB/s and 1,000–11,800 IOPS, Medium 39–261 MB/s and 2,000–11,800 IOPS. The disk is
  1.4 % utilised, so neither limit matters today.
- Supabase publishes no CPU baseline for the shared sizes; its "burst" figures are for the disk.

**For Phoenix:** the only option that adds memory to the database server. **Medium now; Large or XL only if Medium's
numbers ask** ([roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md)).

## B — Hetzner Cloud

| RAM | Shared x86 | Shared Arm | Dedicated |
| --- | --- | --- | --- |
| 8 GB | CX33, 4 vCPU: €8.49 (≈ $9.76) | CAX21, 4 vCPU: €10.49 (≈ $12.06) | CCX13, 2 vCPU: €42.99 (≈ $49.44) |
| 16 GB | CX43, 8 vCPU: €15.99 (≈ $18.39) | CAX31, 8 vCPU: €20.99 (≈ $24.14) | CCX23, 4 vCPU: €85.99 (≈ $98.89) |
| 32 GB | CX53, 16 vCPU: €29.49 (≈ $33.91) | CAX41, 16 vCPU: €40.99 (≈ $47.14) | CCX33, 8 vCPU: €138.49 (≈ $159.26) |

- **Add:** a public IPv4 address, €0.50 (≈ $0.58) a month; IPv6 is free. Backups are priced "starting at €1.198", which is
  20 % of the smallest server; that the 20 % holds for every size is an inference, not stated.
- **Traffic:** 20 TB a month included (30 TB on CCX33), then €1 per TB.
- **Prices rose twice in 2026:** on 1 April for all servers (CX33 from €6.49 to €8.49, CCX13 from €15.99 to €42.99) and on
  15 June for new orders and resizes.
- 🔴 **Availability on 28 Oct:** every create button on Hetzner's site read "currently unavailable", and its status page has
  carried "Limited availability of cloud instances" since 26 June 2026. A server may not be orderable at all today.
- **Networking to Frankfurt:** Hetzner's German sites are Falkenstein and Nuremberg; the database is in AWS Frankfurt.
  Traffic would cross the public internet over TLS, with no private link. The round trip was not measured.
- **Per gigabyte:** CX33 is about $1.22 a GB a month; Supabase's step from Small to Medium is $22.50 a GB. Far cheaper RAM,
  but none of it reaches the database server.

**For Phoenix:** it could run the web app, the worker, a self-run Redis or a self-managed database copy. The first two are
already idle on Railway; the last two are covered under C and H. Whatever runs there reads employee data with the
service-role key, which makes Hetzner a **new data processor** for Phoenix. **Not recommended: it buys capacity Phoenix
does not lack.**

## C — Redis

| Choice | Price | Where it runs | New data processor? |
| --- | --- | --- | --- |
| **Railway Redis, in the production project** | Usage only: RAM $10 a GB-month, CPU $20 a vCPU-month. A cache capped at a few hundred MB: **≈ $1–3 a month (estimate)** | Railway, Amsterdam, beside the app, on the private network | **No** — Railway already runs the app and holds today's cache on its disk |
| Upstash | $0.20 per 100,000 commands, or a fixed 250 MB plan at $10 | Upstash's own regions | Yes |
| Redis Cloud | 250 MB at $7 a month | Redis's own cloud | Yes |
| Self-run on Hetzner | From €8.49 (≈ $9.76) plus IPv4 | Germany, over the public internet | Yes, and a server to patch |

At an assumed one million cache commands a day, Upstash's pay-per-command price would be about $60 a month and its fixed
plan $10. The command count has not been measured.

The four things the brief asks of any cache:

- **Isolation.** A Railway Redis service lives inside the production project's private network, with no public address
  and its own password held as a Railway variable. It is separate from the device-management service.
- **Row security.** Redis has none. Postgres enforces row security on the read; the cache stores the result. So the guard
  is the cache key: **every key carries the caller's access scope**, the value is written only after the server-side
  permission check, and nothing personal is stored under a shared key. This is exactly what the
  [26 Oct cache audit](../production-audits/cache-audit-2026-10-26.md) requires of today's cache; most Phoenix reads use the
  service role and enforce access in the app, so the scope in the key is the same boundary as today.
- **Lifetimes.** The same as today: 5 minutes for most cached reads, 1 hour for some. Moving the cache changes where it
  lives, not how long it holds. Tag invalidation then reaches the web app and the worker together; today each keeps its
  own copy. A memory cap with least-recently-used eviction keeps the bill fixed.
- **Failure.** A Redis error, or a reply slower than a short timeout, counts as a cache miss and the read goes to the
  database, as it does today after every deploy. **A Redis outage makes Phoenix slower, never wrong and never down.** An
  access decision is cached only for its stated lifetime, so a role change or a disabled account still takes effect within it.

**For Phoenix:** Railway Redis, as [roadmap item 2d](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md#stage-2--take-load-off-the-database-no-new-spend-one-pull-request-each).
The others add a data processor and sit further from the app.

## D — External workers and BullMQ

- Today the worker on Railway averages **0.010 vCPU**. The job queue is the `background_jobs` table; schedules run from
  cron-job.org and pg_cron.
- BullMQ needs Redis and adds retries, concurrency limits, rate limits and delayed jobs. The table queue already does what
  Phoenix uses.
- **The cost of Phoenix's jobs is SQL that runs inside the database.** A worker on a faster machine waits on the same
  database.
- A worker outside Railway would hold the service-role key on another provider: a new data processor and a wider
  exposure of the key.

**For Phoenix:** no. Revisit only if `background_jobs` shows a backlog caused by the worker rather than the database.

## E — Cloudflare

Cloudflare already holds the DNS, without proxying.

| Product | Price | What it could do for Phoenix |
| --- | --- | --- |
| Proxy and cache, Free plan | $0; 10 cache rules; tiered cache | Serve static files (`/_next/static`, images) from the edge. Pages and API answers are dynamic and personal. |
| Pro plan | $20 a month billed yearly, $25 monthly | More rules and a firewall; nothing measured needs it. |
| Workers Paid | $5 a month: 10 M requests, then $0.30 a million; 30 M CPU-ms | Code at the edge that reads employee data, on a new processor. |
| R2 storage | $0.015 a GB-month, no egress charge | Could hold the touch-trail archive; the plan keeps it in a private Supabase bucket. |
| Queues | Not priced in this read | No use found: the job queue is not a bottleneck (option D). |
| Hyperdrive | Included in Workers | **Not applicable:** Phoenix reaches the database over HTTP through the API layer, not over a Postgres connection. |

- **The most it could save:** the web app sent 28.7 GB in 7 days, about 123 GB a month, which is about $6 at Railway's
  $0.05 a GB. Only part of that is static, so a proxy would save less than $6 a month.
- **The database is untouched:** everything a CDN could cache is a static file that Railway serves, not Supabase.
- **Risks:** one wrong cache rule can serve one person's page to another; TLS would end at Cloudflare, making it a processor
  of all traffic; the visitor address the app sees would change, and any logic that reads it would need checking.

**For Phoenix:** not now.

## F — Oracle Cloud Always Free

- **Arm (A1):** Oracle's Always Free page states 2 OCPU and 12 GB. Its Arm pricing page and price list give paid accounts
  4 OCPU and 24 GB free; the pages conflict. Above the free amount, $0.01 an OCPU-hour and $0.0015 a GB-hour. 200 GB of
  block storage and 10 TB a month of outbound traffic are free.
- **Idle reclaim:** an instance can be reclaimed when, over 7 days, its 95th-percentile CPU, network and memory use all stay
  under 20 %. Phoenix's app tier, at 0.12 vCPU in working hours, would look idle.
- **Limits:** instances only in the home region; "out of host capacity" errors when the region is short.
- A new data processor.

**For Phoenix:** free, but its reclaim rule fits Phoenix's quiet load exactly. Not for production; fine for an experiment
that holds no employee data.

## G — Other providers

About 8 GB and 16 GB virtual machines, monthly, Frankfurt or Amsterdam where offered:

| Provider | About 8 GB | About 16 GB | Notes |
| --- | --- | --- | --- |
| DigitalOcean | $48 (Basic, 4 vCPU) | $96 (Basic, 8 vCPU) | Premium AMD $42 and $84 |
| Vultr | $40 (4 vCPU) | $80 (6 vCPU) | Frankfurt available |
| Scaleway | €25.19 ≈ $28.97 (Arm, 2 vCPU) | €50.30 ≈ $57.85 (Arm, 4 vCPU) | Amsterdam and Paris; VAT and IPv4 not verified |
| AWS EC2, Frankfurt | $56.06 (t4g.large, 2 vCPU) | $112.13 (t4g.xlarge, 4 vCPU) | Same region as the database; disk and IPv4 extra |
| AWS Lightsail | $44 (2 vCPU) | $84 (4 vCPU) | Frankfurt; IPv4 included |
| Google Cloud e2 | $63.02 Frankfurt, $53.85 Netherlands | $126.05 Frankfurt, $107.71 Netherlands | Disk and IP extra |
| Fly.io | ≈ $58.57 shared, ≈ $103.85 performance | ≈ $207.69 performance | Not verified: worked out from Fly's published rates |
| OVHcloud, Contabo, Render | Not verified | Not verified | Pages could not be read down to the plan |

32 GB sizes were not read for these providers; the 8 and 16 GB rows already settle the comparison. **Every one costs more
than Hetzner's shared servers and buys the same idle app capacity.** AWS Frankfurt is the only one in the database's own
region, so it would have the shortest round trip, and it still adds no database memory.

**For Phoenix:** no, for the same reason as B.

## H — Read replicas

**A Supabase read replica:**

- Inherits the primary's compute size; Small is the minimum, and up to 2 replicas are allowed below XL.
- **Cost for Phoenix: ≈ $17 a month** (Small compute $15, plus disk billed at 1.25 times the primary's: 15 GB at $0.125 =
  $1.88), and about $4 more if the IPv4 add-on is on ($0.0055 an hour). The compute credit and the spend cap do not cover
  replicas.
- **Routing:** Supabase's API load balancer can send GET requests to a replica; Auth, Storage and Realtime stay on the
  primary. supabase-js sends a function call (`.rpc`) as a POST by default, so the heaviest functions would stay on the
  primary unless each read-only call is changed.
- **Lag:** a replica trails the primary, so a screen can read just before its own save lands. Every read-after-save path
  would need review.
- **Memory:** the replica is a second 2 GB machine. The primary keeps its own swapping for every write and every function call.

For about $17–21 it adds a second 2 GB machine; for $45, Medium doubles the memory of the machine doing all the work, with
no code change.

**A self-managed copy on another provider** (Postgres on Hetzner or elsewhere, fed by logical replication):

- Employee records would live with a new data processor.
- A stalled copy keeps write-ahead log on the primary's 12 GB disk and can fill it, stopping production.
- Every schema change has to land in two places, and one owner has to run it.

**For Phoenix:** neither now. A Supabase replica is the option to price again if reports must be isolated from the
working day, after Medium ([roadmap, Stage 3](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md#stage-3--only-if-the-evidence-asks-for-it)).

## I — Optimisation without new servers

The ranked list is in the [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md#the-ranked-opportunities); the
plan is [Stage 2 of the roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md#stage-2--take-load-off-the-database-no-new-spend-one-pull-request-each).

- **What it can do:** cut the pages the CRM views and contact-assignment reads walk, stop the import-row search reading its
  table from disk, cap the touch trail, keep the cache across deploys, and fold repeated polling reads into fewer requests.
- **What it cannot do:** shrink the 512 MB of shared buffers or the platform services that share the 2 GB machine. It
  lowers the memory the working day touches; it does not add memory.
- **Cost:** $0 beyond the cache service. Effort: one pull request per item, each with its own acceptance.

**For Phoenix:** yes, in every architecture.

## All options at a glance

| Option | Extra a month | Adds database memory | Lowers database work | New data processor | Verdict |
| --- | --- | --- | --- | --- | --- |
| A — Supabase Medium | +$45 | **yes, +2 GB** | no | no | **Do first** |
| A — Supabase Large or XL | +$95 or +$195 | yes | no | no | Only on evidence |
| B — Hetzner 8 to 32 GB, with IPv4 | €8.99 to €29.99 (≈ $10.34 to $34.49) | no | no | yes | No |
| C — Redis inside Railway | ≈ $1–3 (estimate) | no | **yes, repeated reads** | no | **Do (2d)** |
| C — Redis with another provider | $7 to $10 or more | no | yes | yes | No |
| D — External workers, BullMQ | from €8.99 (≈ $10.34) | no | no | yes | No |
| E — Cloudflare | $0 to $25 | no | no | yes | Not now |
| F — Oracle Always Free | $0 | no | no | yes | No |
| G — Other providers | $40 to $126 | no | no | yes | No |
| H — Supabase read replica | ≈ +$17 to +$21 | no (a second 2 GB machine) | partly, GET requests only | no | Not now |
| I — Optimisation | $0 | no | **yes** | no | **Do (Stage 2)** |

## Sources

All read on 28 Oct 2026.

- **Supabase:** [pricing](https://supabase.com/pricing) ·
  [compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk) ·
  [compute usage](https://supabase.com/docs/guides/platform/manage-your-usage/compute) ·
  [read replicas](https://supabase.com/docs/guides/platform/read-replicas) ·
  [replica usage](https://supabase.com/docs/guides/platform/manage-your-usage/read-replicas) ·
  [IPv4](https://supabase.com/docs/guides/platform/manage-your-usage/ipv4) ·
  [connection limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits)
- **Railway:** [pricing](https://railway.com/pricing) · [pricing reference](https://docs.railway.com/reference/pricing) ·
  [Redis](https://docs.railway.com/databases/redis) · [regions](https://docs.railway.com/reference/deployment-regions) ·
  [Railway Metal](https://docs.railway.com/railway-metal)
- **Hetzner:** [cost-optimised](https://www.hetzner.com/cloud/cost-optimized) ·
  [regular performance](https://www.hetzner.com/cloud/regular-performance) ·
  [general purpose](https://www.hetzner.com/cloud/general-purpose) ·
  [IPv4 pricing](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/) ·
  [backups](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/) ·
  [VAT](https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/value-added-tax/) ·
  [price adjustment](https://www.hetzner.com/pressroom/statement-price-adjustment/) · [status](https://status.hetzner.com/)
- **Redis:** [Upstash pricing](https://upstash.com/pricing/redis) · [Redis Cloud pricing](https://redis.io/pricing/)
- **Cloudflare:** [plans](https://www.cloudflare.com/plans/) ·
  [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/) ·
  [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- **Oracle:** [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) ·
  [Arm pricing](https://www.oracle.com/cloud/compute/arm/pricing/)
- **Others:** [DigitalOcean](https://www.digitalocean.com/pricing/droplets) · Vultr's public plans API
  (`api.vultr.com/v2/plans`) · Scaleway's public catalog API · AWS's on-demand price data for Frankfurt ·
  [Lightsail](https://aws.amazon.com/lightsail/pricing/) ·
  [Google Cloud general-purpose](https://cloud.google.com/products/compute/pricing/general-purpose) ·
  [Fly.io](https://fly.io/docs/about/pricing/) · [OVHcloud VPS](https://www.ovhcloud.com/en/vps/) ·
  [Contabo](https://contabo.com/en/vps/) · [Render](https://render.com/pricing)
