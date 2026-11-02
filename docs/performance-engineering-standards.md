# Performance Engineering Standards

These rules are mandatory. They exist because every one of them was violated at least once and
directly caused or worsened the 2026-07-02→04 production incident (Source-of-Sales dashboard
queries spilling ~161GB of temp files under an undersized `work_mem`, degrading the entire
platform for roughly two days). See `docs/production-audits/` for module-level audit tracking;
this file is the durable, repo-wide checklist that should prevent a repeat of that incident's
shape, not just its two specific symptoms.

## Query design

1. **Never query a raw analytics/import table directly from a request-facing RPC once a
   rollup or fact table exists for that data.** Read the rollup. If no rollup exists yet for a
   large table (roughly >50MB or >50k rows), that's a signal one is needed before shipping,
   not after.
2. **Never ship a new analytics feature before its rollup/fact path is wired in and its
   output verified to match the raw-table path.** "The rollup exists but isn't wired in yet"
   is not a safe interim state — it was the exact gap that caused the incident.
3. **Never use `count: "exact"` (or raw `COUNT(*)`) over a large or joined result set**
   without an index-backed fast path or explicit sign-off. Exact counts force materializing or
   re-scanning the matching set.
4. **Never add `ORDER BY` over an unbounded result set** without confirming an index covers
   it, or that the set is already capped to a small page size.
5. **Never write a new SQL function with an internal `GROUP BY`/`DISTINCT`/`ORDER BY` over a
   large joined result** without either a function-level `work_mem` override
   (`ALTER FUNCTION ... SET work_mem = '...'`) or a rollup-based rewrite that avoids the sort
   entirely.
6. **Never expose a heavy aggregation RPC to `anon` or `authenticated`** if it's only ever
   called server-side. Grant `service_role`-only execute in that case.

## Shared data access

7. **Never fetch a full table (the employee directory or otherwise) inside a request path.**
   Use a shared, cached accessor. Reinventing a full-table fetch per domain is how the same
   "uncached full directory scan" pattern ended up independently in payroll, activity tracking,
   coaching, and the employee portal.
8. **Always add caching (`unstable_cache` for cross-request reuse, React `cache()` for
   per-request dedup) for any read that is expensive or used by more than one page/component.**

## Frontend

9. **Never add a client-side polling interval (`setInterval`, recursive `setTimeout`) without
   a max-attempts or max-duration ceiling.** A backend job stuck "running" must not be able to
   drive indefinite request volume.

## Before merging

10. **Always run `EXPLAIN ANALYZE` (or rely on `auto_explain` once it's enabled — see
    `docs/observability.md`) against a realistic data volume before merging a new heavy
    query** — not an empty local/dev database. An empty-table query plan hides exactly the
    problem this standard exists to catch.
11. **Always check for exact-duplicate indexes before adding a new one** — several tables in
    this database have carried 2-3 byte-identical indexes from repeated migrations.
12. **Always give a new cron job an explicit `maxDuration`, wrap its work in `withDeadMansSwitch`
    with a new slug, and add a matching Healthchecks.io check** (Cron Expression mode,
    `Africa/Cairo` timezone, grace >= 2x the job's max runtime — see the dead-man's-switch section
    in `docs/observability.md`; Sentry monitors no longer exist).

## Data lifecycle

13. **Always decide a new high-write-volume table's retention/archival policy at creation
    time, not after.** The notifications domain already does this correctly (90-day cleanup);
    `audit_logs` and `attendance_raw_punches` do not, and both grow unbounded today.

## Working in this repo

14. **Always check `git worktree list` and diff against `origin/main` before starting
    frontend performance work.** This repo runs concurrent sessions/branches routinely; a
    caching fix has already nearly been duplicated once because it had already landed on
    `origin/main` from a parallel session before another session went looking for it.

## A filter argument is resolved once per call, never once per row

15. **Never test a scalar against an array argument with a bare sublink — wrap it in `ARRAY( )`.**
    `v <> ALL (select … from unnest(p_codes) as c)` is planned as an uncorrelated `SubPlan`, and
    Postgres re-executes it for EVERY candidate row rather than once. `v <> ALL (ARRAY(select …))`
    is an uncorrelated scalar the planner lifts to an `InitPlan`. The edit is seven bytes per site.
    Measured on production 2026-10-23 against `phx_exec_customers` over one line-month, the
    `Function Scan on unnest` went from loops=295,418 and 1,322 ms to loops=1 and 357 ms — both read
    WARM at `shared hit=8,304` with zero disk reads, because the first old-form reading came off disk
    and would have overstated the gain. A cold reading must never be the "before". End to end the
    same call is 970 ms cold and **377 ms warm for 13,100 rows** at `shared hit=7,873`. The row counts
    are identical on both plans (61,875 kept per worker, 36,598 removed), which is the equivalence at
    plan level; the behavioural proof sits in each migration's header.

16. 🔴 **`array_agg` is NOT the same fix and must never be substituted for `ARRAY(subquery)`.**
    `ARRAY(subquery)` over an empty input yields an EMPTY array, so `v <> all ('{}')` is TRUE and
    nothing is filtered out. `array_agg` over an empty set yields NULL, `v <> all (NULL::text[])` is
    NULL rather than TRUE, and every row is dropped in silence. That is also why no `coalesce` is
    needed here, and why routing the hoist through an aggregate would reintroduce the need for one.
    A short-circuit guard in front of the test — `p_codes is null or …`, or `cardinality(p_codes) = 0
    or …` — is a cheap exit, not the correctness: a site carrying no guard at all is still correct.

## Guards and timing (performance phase 3, 23 Oct 2026)

17. **A rep's own page reads the CRM door with a person, customer or visit key — never the whole
    company.** `tests/performance-phase-3.test.ts` finds every `queryVisits`, `queryVisitsLimited`,
    `queryCheckins` and `queryPlanEntries` call in the four rep-page files and fails one that names
    none of `agentCrmIds`, `agentHrIds`, `agentCrmOrHrIds`, `agentHrIdILike`, `doubleHrIds`,
    `contactCrmIds` or `visitIds`.

18. **No new OFFSET walk over a unified CRM view, and no new direct reference-list read.** Both are
    ratchets with a per-file baseline taken 2026-10-23 that may only fall. Page a unified view with
    the keyset reader (`walkMasterExportPages`, `docs/crm-ordered-door-pages.md`); read `lines`,
    `areas` and `departments` through `src/lib/reference/reference-lists.ts`. A file that drops below
    its baseline fails too, so the gain is written down instead of silently spent.

19. **The portal shell is ONE parallel wave.** `employee-portal-server-shell.tsx` awaits exactly
    `assertPermission`, one `Promise.all` of four reads, the already-started module-lock promise,
    `headers()` and `cookies()`. A sixth sequential await in front of the page fails the test; add a
    read inside the wave, not beside it. Since 1 Nov 2026 the same test pins `getEmployeePortalShellData`'s
    first wave (`SHELL_DATA_FIRST_WAVE`: the viewer's row, the directory, the manager's name and the photo
    start together on the session's own id; the fingerprint device-mapping count is remembered ten minutes
    under a bare tag the one write busts) and the awaits of five portal pages — business review, employee
    360, fingerprint analytics, interview calendar, milestones — as `PAGE_AWAITS_BASELINE`: a page that
    grows a sequential await fails, and one that loses an await rewrites its line so the gain is kept.

20. **Server-Timing is durations only; the browser beacon is a page shape, a kind, a device class
    and milliseconds — and, since 1 Nov 2026, it is kept by the hour.** Seven Phoenix CRM GET
    routes (overview, today, visits, plans, and since 1 Nov 2026 the List, its board and the Add Visit
    form) and badge-counts answer with `Server-Timing` (`total` plus the stage names `access`,
    `viewer`, `load`, or `cached`/`joined`/`ran` for badges), and the same stages are recorded as
    `route_<label>_<stage>` in the per-minute `process_health` line. `PageTimingBeacon` sends, once
    per hard load when the tab hides, the first byte, first content, largest content (Safari reports
    none), interactive and the first `/api/` answer; `RouteTransitionProvider` measures every tap
    inside the app from the tap to the new route rendering and queues it, ten taps to a beacon or
    when the tab hides. `/api/telemetry/page-timing` records each number under `page_<metric> <path>`
    in the `process_health` line and into the hour's in-process store; the `process_health` tick
    writes each ended hour to `page_timings` (count, median, 90th percentile, worst per page shape,
    kind, device class and metric; pruned at 30 days by `phx_prune_retention`; owner, 1 Nov 2026:
    "hourly medians per page, 30 days, no names"), and `/admin/system-audit?tab=slow-pages` shows the
    week, slowest first. No person is in any of it. A page cannot set `Server-Timing` on its own HTML
    except through `proxy.ts`. These are measurements to be taken after a deploy, not achieved figures.

21. **A CRM board read that grows with the field is ONE SQL function answering one jsonb array, never
    a wave of chunked requests.** A production read costs ~450 ms at Supabase's edge for 2–7 ms of SQL
    (measured 1 Nov 2026, below), so the request count is the lever. The Reps List's check-ins
    (`phx_crm_contact_checkins`) and brick names (`phx_crm_brick_meta`) and the KPI panel's open
    assignments (`phx_crm_open_assignments`) each come from one function, with the page walk kept only
    as the PGRST202 fallback for a database the migration has not reached; the ids a function filters
    on are its PARAMETER, never an `array_agg` sublink (that planned a 346 ms full scan of the view).
    Pinned by `tests/phoenix-crm-board-reads.test.ts`.

22. **A reference table a board reads whole is a shared copy with a namespace in
    `src/lib/crm/shared-windows.ts`, and every write that changes it bumps that namespace before it
    answers.** The region → brick map, the trade counterparties (six whole-table reads per board open
    before) and the KPI panel's open assignments joined the contact roster there on 1 Nov 2026; a
    decision or an audit never opts into the copy (`reuseRecentWindow` is for display boards). The
    same test pins the namespaces and the refresh calls in region-brick, direct orders and marketing.

23. **A screen mints the reference list through `ensureReferenceCustomersRecently`, never
    `ensureReferenceCustomers`, unless it looks for exactly what a mint would add.** The List and the
    Add Visit form joined the two planners behind the five-minute throttle on 1 Nov 2026; missed
    records still mints every time. The unvalidated-visit counts behind the form read their id chunks
    four at a time (`mapWithConcurrency`). Pinned by `tests/phoenix-crm-reference-mint-throttle.test.ts`.

## The speed root cause (measured 1 Nov 2026)

The owner's brief, 1 Nov 2026: measure every Phoenix CRM and employee-portal page as a signed-in rep,
record everything, find the root cause before any compute upgrade, and fix it. Measured in a rep's own
browser (hard loads, desktop, a quiet Sunday evening), with production HTTP logs, Supabase edge logs,
Postgres statement statistics and the database host sampler for the whole day.

### What the rep saw (milliseconds)

| Page | First byte | First paint | Usable | What held it |
| --- | --- | --- | --- | --- |
| Phoenix CRM · Visits | 969 | 1,156 | ≈5,800 | the client booted until ~2.6 s, THEN `visits` 1,233 · `visits/form` 1,368 · `commitments` 1,237 · `call-prep` 1,231 |
| Phoenix CRM · List | 1,072 | 1,204 | 5,078 | `list` 2,848 · `list/board` 3,124 |
| Phoenix CRM · Plan | 619 | 720 | 2,814 | `monthly-plans` 1,491 |
| Phoenix CRM · Calendar, Directory, Day, Reports | 540–1,010 | 640–1,470 | 1,680–2,430 | shell chatter only |
| Phoenix CRM · My Map | 673 | 996 | 2,243 | Google Maps JS |
| Home | 1,112 (4,422 at 20:30) | 1,476 | 3,182 | `pulse` 1,463, settings 469 |
| Weekly Stock | 1,018 | 1,680 | 13,312 | server render 12.9 s, 428 KB HTML |
| Business Review | 1,545 | 2,260 | 10,605 | server render 10.5 s |
| Ranks | 1,649 | 2,204 | 8,971 | 2,799 KB HTML |
| Source of Sales | 563 | 1,144 | 8,760 | server action 7,044 |
| Territory Drilldown | 1,069 | 1,348 | 6,023 | `/area/D12` 3,349 · `/totals` 3,353 |
| ROI Tracker | 1,466 | 1,824 | 6,783 | `roi-tracker` 3,167 |
| KPIs · Coverage | 1,305 | 2,172 | 4,622 | |
| Employee 360 | 1,071 | 1,720 | 4,119 | sequential awaits |
| Targets / My Visits | 2,636 / 3,278 | 3,280 / 4,228 | 4,130 / 3,963 | server render |
| Every other portal page | 450–1,540 | 760–2,080 | 1,500–3,900 | shell chatter: `pulse` 600–1,900 · `messages` 300–960 · `mailbox/unread` 400–1,580 · `push/context` 180–920 · `push/register` 240–860 |

Taps inside the app: Visits → chooser 2.3 s to content; chooser → List 3.1 s (`list` 2,322 and
`list/board` 2,648, both starting only at 0.5 s); Home → Visits 4.4 s settled.

### Where the time went

1. **Each CRM read cost ~450 ms at Supabase's edge for 2–7 ms of SQL.** Peak half hour (10:30–11:00
   Cairo): 36,104 requests, 1,203 a minute. `phoenix_crm_places` 1,973 reads at a median of 453 ms,
   `phoenix_crm_visits` 1,944 at 495, `phoenix_crm_customers` 1,743 at 473, `validation_reviews`
   1,236 at 489; `pg_stat_statements` for the same statements: 0.8–6 ms mean. About 90 % of every read
   is request handling on a saturated 2-core Small host, not the database — so the request COUNT is the
   lever, not the statement.
2. **A CRM tab open fired 40–60 Supabase requests.** `/list` 15–20 in 4 waves; `/list/board` 20–30 in
   5–6 (each contact's whole check-in history in 50-id chunks, six uncached whole-table reads of the
   trade counterparties, the brick map → names → areas in chunks); `/visits/form` 22–28 with an
   unthrottled reference mint in front; `/monthly-plans` 25–30; `/call-prep` 8–12 in 4–6 sequential
   waves. Each request paid the session RPC first, and every wave waited ~450 ms.
3. **The shell talked on every page view, for every role, and kept talking.** About 15 requests
   before any data — the pulse (session plus three waves of notices), the messages list, the mailbox
   probe (five sequential reads to answer "not connected"), the push context and a register upsert, the
   activity track, the touch trail — plus the pulse every 30 s per open tab (3,495 session-bundle calls
   in the peak half hour, 9.7 % of all requests). The touch trail alone was 2,833,242 rows and 1,224 MB,
   26 % of the database.
4. **Data was fetched in series across two network boundaries.** The server rendered the shell
   (0.6–1.0 s, 2.4–4.4 s with the host busy), the browser downloaded and ran ~2 MB of JavaScript, and
   only then did the tab's data requests start.
5. **Eight pages do seconds of work per request with no cache** (the table above).
6. **Not the cause, recorded so nobody chases it:** the `_rsc` prefetches (a median of 36 ms each on
   Railway; two per link is Next 16's segment cache, and the loading-skeleton prefetch is the owner's
   2026-10-23 rule); Postgres itself (mean statement 4.3 ms, cache hit 98.84 %, 4.7 GB). Also that day:
   production Postgres restarted uncleanly at 14:03 Cairo with the host this short of memory (582 5xx),
   and four hand-run `create temp table … as execute` analyses of 40–125 s ran on production after it.

A correction of record: PR 6714's description said "each query runs in milliseconds" — true of the
statement, not of the request, which cost ~450 ms at the peak.

### What changed, and when

- **Stage 0 (1 Nov 2026):** the touch trail retired on the owner's word and its table dropped.
- **Stage 1 (2 Nov 2026):** the shell's chatter — the bell's notices, the unread count and the
  internal-messages badge from one statement (`phx_in_app_notices`) after the session, the messages
  list fetched when the menu opens, the mailbox hook silent when the shell says no mailbox is
  connected, the push viewer in the shell HTML with a registration skipped inside the week, page views
  batched every 30 s; the shell's data one wave and five pages' awaits pinned (item 19); every page's
  timing kept by the hour (item 20); the List, its board and the Add Visit form (items 21–23).
- **Stage 2 (2 Nov 2026):** a seat's customers, places and venues from one function
  (`phoenix_crm_territory_customers`, with the List's status filter and a day's customer-id filter), so
  the List, Add Visit, both planners and the call prep read one request where they read three; the call
  prep's whole day from another (`phoenix_crm_planned_day`: the week's plan row, the day's items, the
  edit requests, the returns and the stops) where it stood on five sequential waves; the month
  planner's first wave two reads, not four, and the sends read four chunks at a time; the venue names
  taken from the territory read instead of a second read of the same rows; the Ranks board drawing each
  insignia once (a sprite the badges `<use>`: 64 copies of a 21 KB eagle were the 2.8 MB) and
  remembered per window and audience for an hour under a tag the nightly compute drops; Weekly Stock
  remembered per scope and filters for five minutes under a tag every weekly write and a price edit
  drop, stored gzipped like the Sales vs Target rows. Both planners' routes answer with
  `Server-Timing`. Measured before, on production at 02:25 Cairo: Weekly Stock 10.7 s to the response
  end (429 KB), Ranks 8.4 s (2.8 MB, 300 inline SVGs), call prep 1,150 ms; the after figures are read
  the same way once it serves.
- **Deliberately not remembered:** the Business Review (it reads the LIVE engine, AGENTS.md §4, and
  its bundle is already cached), Source of Sales (a whole-line read is a sales-rules change), ROI
  Tracker and Coverage (KPI rules, 1.8 s and 4.6 s), Territory Drilldown. Still open from Stage 1, on
  purpose: `readOpenList` pages by OFFSET; the shell does not yet embed its stage durations.

### The compute question

Postgres is fast; the HOST is saturated by request handling on 2 shared cores with 1,932 MB and swap in
use, and it restarted uncleanly 14 times between 7 and 25 Oct and again on 1 Nov at 14:03 Cairo. Stages
0–2 cut the request count, which is the root cause. A larger tier does not change the request count and
is the only lever on the restarts and the swap; it is decided on the Supabase dashboard (Project →
Settings → Compute and Disk), never in chat. Measure after each stage, same hour against the same
figures: requests per minute at the Monday 10:30–11:00 peak against 1,203; the `phoenix_crm_places`
median against 453 ms; session-bundle calls against 3,495 per half hour; CPU idle and swap against
20–57 % and 191–483 MB (`docs/environment.md`, the host bullet).

## Related documentation

- [Database](database.md) - schema and migration conventions
- [Migrations](migrations.md) - migration policy
- [Observability](observability.md) - error capture, alerting, cron dead-man's-switch
- [Editing Guide](editing-guide.md) - where to make edits, quality gate workflow
