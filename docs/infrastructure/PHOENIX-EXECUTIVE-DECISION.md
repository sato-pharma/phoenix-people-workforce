# Phoenix — executive decision

> **Replaced on 28 Oct 2026.** The [final validation](PHOENIX-FINAL-INFRASTRUCTURE-DECISION-VALIDATION.md) withdraws the move to Medium recommended below and decides to keep Small and optimise (Decision A), with Medium only if a measured trigger fires. The figures below are corrected; the decision is kept only as a record.

Measured on 28 Oct 2026 from the live systems; nothing was changed, bought or restarted. Supabase stays the one
authoritative database, with no migration. **This is the recommendation; nothing below has been started.**

## The decision

**Move the production database from Small to Medium (+$45 a month), then take load off it with no new spend, keeping a
small cache inside the Railway project that already runs the app.**

The bill goes from **about $90 to about $136–138 a month** (estimate; Railway's usage moves month to month).

## The nine answers

**1. What slows Phoenix?**
The database server's memory. It holds 4.3 GB of data on a 2 GB machine, and in the 55 hours after the 25 Oct fixes it
swapped about 7 GB out to disk, with 2.9 million major page faults. Reads that should come from memory wait on disk, which
is what the afternoon stalls are: a 15-second one on 27 Oct, and 9 crash restarts between 11 and 25 Oct.
A few heavy reads make it worse: the CRM's combined visit, plan and check-in views walked far more pages than they return
(the contact-assignment read stopped on 26 Oct, when the roster cache went live). On 28 Oct the plan view's two heaviest
reads came down by 70 % and 77 %; the visit and check-in views are next. The app servers are not the cause; they use a fifth of one core at the busiest hour.

**2. Does Supabase need more RAM or more CPU?**
RAM. The CPU averages about 20 % of its 2 cores (14.6 % at night), with 0.55 % steal, so there is no sign it is held back. The disk is 1.4 %
utilised and connections have never timed out.

**3. Does external compute help?**
Not with the database. Memory on another machine never becomes the Supabase server's memory, and the app servers it could
run are already idle. What does help is less work for the database: a cache that survives deploys, inside the Railway
project, and lighter reads.

**4. What is the cheapest option?**
The code and database optimisations, at $0, with the cache at about $1–3 a month. They cut the work per page, but they
cannot add memory: Postgres's 512 MB of shared buffers and the platform services already fill most of the 2 GB, and no
code change shrinks them.

**5. What is the fastest option?**
Supabase XL: 16 GB and 4 dedicated cores, +$195 a month, with all the data in memory more than three times over. Nothing
measured asks for it. The fastest to put in place is Medium: one click and a restart that usually takes under 2 minutes.

**6. What gives the best performance per dollar?**
Medium plus the optimisations and the Railway cache: +$46–48 a month for the change that addresses the measured cause,
and the work that stops the database growing back into the limit.

**7. What comes first?**
Medium, on the Supabase screen, after 22:00 Cairo on a working day. Then, one pull request each, the lighter CRM reads and
the fewer polling requests, followed by the import-row search, the touch-trail cap and the cache.

**8. What is the final monthly bill?**

| | Today | Recommended |
| --- | ---: | ---: |
| Supabase (Pro plan, compute, disk) | ≈ $40.50 | ≈ $85.50 |
| Railway (workspace and usage) | ≈ $50 | ≈ $51–53 |
| **Total** | **≈ $90** | **≈ $136–138** |

**9. What gains are realistic?**
Forecasts, to be checked against the [benchmark plan](PHOENIX-MAXIMUM-PERFORMANCE-MINIMUM-COST.md#the-benchmark-plan):

- After Medium: swapping under 10 MB an hour in working hours, major page faults down at least 80 %, no restarts and no
  stall over 5 seconds. The slowest requests should improve most, because they are the ones waiting on disk.
- After the optimisations: the top CRM reads touching at least half as many pages, weekday API requests down at least 20 %,
  and the import-row search no longer reading from disk.
- Typical page times have not been measured yet, so no percentage is promised for them; the benchmark measures them first.

## The assumption the brief asked to challenge

Is more Supabase compute necessary? Every cheaper route was priced and tested against the measurements:

- **External servers** (Hetzner, Oracle, the others) are far cheaper per gigabyte, but cannot add memory to the database
  and would add a new provider holding employee data.
- **A read replica** is a second 2 GB machine; the primary keeps swapping for every write and function call.
- **Cloudflare** caches static files, which Railway serves, not the database.
- **Optimisation alone** lowers the load but cannot shrink the fixed memory the platform takes.

So one step of Supabase compute is necessary, for memory only: **Medium, not dedicated CPU**. If the owner prefers the
brief's strict order, the optimisations can go first and Medium wait until they are measured
([architecture A](PHOENIX-RECOMMENDED-ARCHITECTURE.md#a--lowest-cost-stay-on-small-take-load-off)); the cost of waiting is
the risk of another working-hours restart.

## What it takes from the owner

- **One click:** Supabase → Project Settings → Compute and Disk → Medium, on the production project, after 22:00 Cairo on
  a working day. Going back is the same screen, at the cost of one restart.
- **His word** for each optimisation's pull request, one at a time.
- Nothing else is bought. Stage 3 (Large, XL or a replica) is decided only on Medium's numbers.

## The documents

[Baseline](PHOENIX-INFRASTRUCTURE-BASELINE-AUDIT.md) · [PostgreSQL audit](PHOENIX-SUPABASE-POSTGRES-PERFORMANCE-AUDIT.md) ·
[external compute options](PHOENIX-EXTERNAL-COMPUTE-OPTIONS.md) · [cost and performance](PHOENIX-MAXIMUM-PERFORMANCE-MINIMUM-COST.md) ·
[recommended architecture](PHOENIX-RECOMMENDED-ARCHITECTURE.md) · [roadmap](PHOENIX-INFRASTRUCTURE-IMPLEMENTATION-ROADMAP.md).
