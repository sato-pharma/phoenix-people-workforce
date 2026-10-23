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

## Related documentation

- [Database](database.md) - schema and migration conventions
- [Migrations](migrations.md) - migration policy
- [Observability](observability.md) - error capture, alerting, cron dead-man's-switch
- [Editing Guide](editing-guide.md) - where to make edits, quality gate workflow
