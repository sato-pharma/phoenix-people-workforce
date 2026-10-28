# The departed-agent CRM id cache, and why the index was never the problem

`supabase/migrations/20261023190000_crm_agent_crm_ids_cache.sql` ·
pinned by `tests/crm-agent-crm-ids-cache.test.ts` ·
module memory: `.claude/rules/crm-unified-doors.md`

Owner's instruction, 2026-10-23, chosen over leaving it alone: **"Cache the 254 pairings"**.

> 🔴 **The cache holds 172 rows, not 254** — read back on production straight after the migration
> was applied. 254 was the count of `distinct (agent_hr_id, agent_crm_id)` with no filter on the
> key, and **83 of those pairs carry a NULL `agent_hr_id`**, which the door can never match:
> `where c.agent_hr_id = any(p_agent_hr_ids)` is never true for NULL, and the pre-cache body had
> the same blind spot. `_calc()` drops them explicitly, so the keyed set is 172 (255 pairs on the
> day of writing, 83 of them NULL-keyed). Every "254" below is corrected to the measured number;
> the quoted instruction above is left in the owner's own words.

## What was there

`phx_crm_agent_crm_ids_for_hr_ids(text[])` has, since
`20260914000000_crm_unify_vendor_reads.sql`, answered "which CRM ids did these people visit under"
with twelve lines:

```sql
select distinct v.agent_crm_id
from public.crm_visits_unified v
where v.agent_hr_id = any(p_agent_hr_ids)
  and v.agent_crm_id is not null
```

It backs the live half of the departed-agent CRM exclusion — `scanDepartedAgentCrmIds` in
`src/lib/crm/reads.ts`, called on every cold `excludedAgentsCache` (5-minute TTL), which feeds
Double Visit Analytics, Field Workforce Compliance and the payroll no-activity detector.

It is not a small read. `crm_visits_unified` is a union door over the iReports360 mirror and
Phoenix's own visits and day activities, and `distinct` over it has to produce every matched row
before it can discard duplicates.

## What it is now

* **`crm_agent_crm_ids_calc(p_agent_hr_id text default null)`** holds the one body — the same
  `select distinct … from public.crm_visits_unified`, widened to return the PAIR
  `(agent_hr_id, agent_crm_id)` and narrowable to one agent.
* **`crm_agent_crm_ids_cache`** is that pair set as a table: **172 rows**, primary key
  `(agent_hr_id, agent_crm_id)`. RLS on, revoked from `public`/`anon`/`authenticated`, granted to
  `service_role` — exactly the reach the door already had.
* **`crm_agent_crm_ids_rebuild()`** empties and refills it THROUGH `_calc()`, so there is no second
  copy of the rule. Its `delete … where true` is load-bearing, not decoration: see below.
* **`crm_agent_crm_ids_reconcile()`** compares the cache with `_calc()` with `except` both ways,
  rebuilds on any difference and raises a warning. Scheduled hourly at minute 7 (`7 * * * *`, every 15
  minutes until 2026-10-25 — see "Hourly since the load audit" below) as
  `crm-agent-crm-ids-reconcile`, which since 2026-10-23 runs it through
  `crm_agent_crm_ids_reconcile_run()` so every run reports to the heartbeat register — see
  "Who watches the reconcile" below.
* **The door keeps its name, signature, `returns table(agent_crm_id bigint)`, `stable`,
  `security definer`, `search_path`, `statement_timeout` and both grants**, and now reads the
  cache. `src/lib/crm/reads.ts` is not touched by this change, and its PGRST202 page-walk fallback
  stays exactly as valid as it was.
* The migration backfills and then **refuses to commit** on a single disagreement or on 0 rows.

## What it bought, measured on production

Live-shaped input: the 108 non-active employees the live tier actually passes, expanded through
`expandHrIdFilterValues`, returning 76 distinct crm ids.

| | time | shared buffers |
| --- | --- | --- |
| before | 220 ms | 57,005 |
| after | **2.3 ms** | **406** |

The read scanned ~136,000 visit rows and quicksorted 140,616 of them to return 76 integers. The
after figure is the same `explain (analyze, buffers)` on production once the migration was applied
(2026-10-23, 17:10 Cairo): a Function Scan returning **the same 76 rows**, 406 shared buffers of
which 198 belong to the `employees` lookup that builds the input array — so the door itself costs
208 buffers. Same answer, ~96x less time.

## 🔴 The index was never the problem — do not try that again

On 2026-10-23 the duplicate `ireports360_visits_agent_idx` was dropped
(`20261023181000`): a btree on `(agent_hr_id)` that was a strict prefix of
`perf_ireports360_visits_agent_hr_id_visit_date_crm`. A 3–5× win was predicted on the strength of a
projected index-only scan. **It did not happen.** 189 ms before the drop, 220 ms after, same shape;
the plan simply moved to the surviving index.

The projected index-only scan is impossible: the door's iReports360 branch projects the whole row
(width 1218), so every matched row is fetched from the heap whatever the index covers. The cost is
the row set the `distinct` forces, and the only way to stop paying it per call is to stop computing
it per call.

**The same holds for the indexes added on 28 October** (`20261028024500`, roadmap Stage 2a):
`ireports360_visits_agent_hr_date_id_idx` on `(agent_hr_id, visit_date, id)` INCLUDE
`(agent_crm_id, double_hr_id, agent_name, double_name)`, and `ireports360_visits_agent_crm_date_idx`
on `(agent_crm_id, visit_date)`. The INCLUDE list was added for an index-only scan the door cannot
give — the plan still reads `Index Scan` at row width 1,223. The hr index wins another way: with `id`
in the key, a reader's `id > $last` keyset is checked on the index tuple, so only the rows past the
cursor are fetched from the heap. Measured on production, pages per call, rows md5-identical: rep
visits in a window by keyset 13,789 → 6,236 (−55 %), the same with names 13,879 → 6,320 (−54 %), an
agent by CRM id or hr id in October 28,233 → 24,692 (−13 %, the CRM-date index). 🔴 **One reader got
heavier:** `getMappedAgentHrIds` in `src/lib/crm/reads.ts` (17,900 → 23,345, +30 %). It reads every
visit a set of reps ever made, with no lower date, to learn which of them has any; the planner now
guesses 3,744 rows and picks a plain index scan, one heap page per row, where it used to bitmap-scan
each page once. Its cure is in that reader — it needs one visit per rep — never in the door.

🔴 **The two older indexes this one would replace STAY — the owner declined dropping them on
28 October 2026** (`perf_ireports360_visits_agent_hr_id_visit_date_crm` and
`ireports360_visits_agent_crm_id_idx`). Each one's keys are a prefix of its new neighbour's, so the
planner no longer needs them; `tests/crm-agent-crm-ids-cache.test.ts` refuses a drop of either in any
later migration, and that pin changes only with his word.

What the drop did buy is real and small — 2.8 MB back and one less index maintained on every
insert into a 1.6-million-row table. **It was applied to PRODUCTION only; staging still carries the
duplicate index.**

A related dead end, for anyone measuring this again: a hand-written `with ids as materialized (…)`
form measures nothing. The planner cannot push `= any(ids.a)` down, falls back to
`ireports360_visits_visit_date_idx` and scans the whole table (1,035 ms). Only a literal array
reproduces the live plan.

## 🔴 The hourly reconcile is the staleness bound, not a safety net

`crm_person_by_hr_key_cache` hangs an AFTER STATEMENT trigger on `employees`, its one input, and
its reconcile is a safety net. **This cache has no such trigger and cannot have one**:
`crm_visits_unified` draws on ~10 input tables. A pair can be up to an hour old.

That is safe for THIS read, and only because of what the read is for. A pair enters the set when a
rep first records a visit under a CRM id. A departed rep records no new visits, so a departed
person's pair set is historical and frozen. The only pair a one-hour window can miss belongs to
someone whose FIRST EVER visit landed in the last hour — who is, by construction, active, and
therefore not in the question being asked.

**Re-check that argument before reusing this cache for anything else.**

### Hourly since the load audit (2026-10-25)

The production load audit after the 25 Oct 16:14 Cairo restart (the 2 GB database box, 11 restarts in
14 days, all in working hours) found `crm_agent_crm_ids_reconcile_run()` the second-heaviest
statement on the database: 30 runs in seven hours, 118 s in all, a 3.9 s mean and a 9.7 s peak. Every
run recomputes `_calc()` — the full `distinct` over `crm_visits_unified` — to learn whether one
pair changed, and almost always none had. The argument above holds for any window shorter than a
departure, so `20261026000000_crm_agent_crm_ids_reconcile_hourly.sql` moved the job to `7 * * * *`:
a quarter of the runs, and minute 7 keeps it off the top-of-hour pile-up. The command is still the
reporting wrapper and no function body changed. The declaration in `JOB_SCHEDULES` moved with it,
with a two-hour grace so an on-time run never reads late. Pinned by
`tests/crm-agent-crm-ids-reconcile-heartbeat.test.ts` (the LAST migration to schedule the job must
say `7 * * * *`, and the declaration must match it). Rollback: re-schedule `*/15 * * * *` with the
same command and put the declaration back to a one-hour grace.

## Who watches the reconcile

Owner's instruction, 2026-10-23: **"fix the departed-agent CRM cache that freezes silently if its
cron stops"**. Until then nothing did: the pg_cron job wrote no heartbeat, was not in
`JOB_SCHEDULES`, and — because the door never falls back — a stopped job would have left the cache
frozen with every read still answering, quickly and wrongly.

`20261023220000_crm_agent_crm_ids_reconcile_heartbeat.sql` adds two functions and re-points the job:

* **`phx_record_job_heartbeat(slug, outcome, detail)`** is the SQL twin of `recordJobHeartbeat` in
  `src/lib/observability/job-heartbeat.ts`: an upsert into `public.job_heartbeats` that moves only
  the timestamp for its own outcome and, if the write itself fails, raises a warning rather than
  failing the job.
* **`crm_agent_crm_ids_reconcile_run()`** runs the unchanged reconcile, then records `success`
  with what it found (`in step: 0 differences against _calc()` or `rebuilt: N row(s)…`).
* The slug **`phoenix-crm-agent-crm-ids-reconcile`** is declared in `JOB_SCHEDULES` on the same
  cadence as the job (`*/15 * * * *` with a one-hour grace then; `7 * * * *` with a two-hour grace
  since 2026-10-25), and in `docs/observability.md` as **in-house only** —
  nothing pings Healthchecks for it. The 15-minute sweep judges it like every other job and pages
  in-app, Telegram and push when it stops.

🔴 **The wrapper does not catch a failed run, on purpose.** pg_cron runs the command in one
transaction, so a `fail` row written there cannot survive a re-raise, and catching the error to
write one would leave `cron.job_run_details` reading `succeeded` for a run that failed. Uncaught, a
failing run is **FAILED** in `cron.job_run_details` (with its message) and **stranded** in the
register once the grace passes — both true. Proven on staging and production on 2026-10-23; pinned
by `tests/crm-agent-crm-ids-reconcile-heartbeat.test.ts`, which also refuses a later migration that
points the job back at the bare reconcile.

## 🔴 Two things that must not be "improved"

**The door does not fall back to `_calc()` on an empty cache.** The one failure mode that matters is
a cache that stopped being rebuilt, and a fallback would hide it behind the slow path this change
exists to remove. The same rule already holds for `phoenix_crm_rep_entry_days()`. An empty cache
must surface.

**`delete from … where true`, never an unqualified DELETE.** PostgREST connects as `authenticator`,
which preloads `safeupdate`; an unqualified DELETE raises `DELETE requires a WHERE clause` there
while succeeding every time in a direct SQL session, the SQL editor or an MCP call. That divergence
killed a candidate's joining form at 13:11:46 Cairo on 2026-10-23 and every employee write with it —
`20261023154500_crm_cache_rebuilds_need_a_where_clause.sql` is the full account.

## Rolling back

Restore the door's body from `20260914000000_crm_unify_vendor_reads.sql`, then
`select cron.unschedule('crm-agent-crm-ids-reconcile')` and drop the table, the three functions and
`crm_agent_crm_ids_reconcile_run()`, and take `phoenix-crm-agent-crm-ids-reconcile` out of
`JOB_SCHEDULES` and both tables in `docs/observability.md` in the same change — a declaration with
no job behind it pages every Super Admin for ever. `phx_record_job_heartbeat()` is generic; leave it.
Nothing else reads any of them, and `src/lib/crm/reads.ts` needs no change either way.

## The reconcile reads `_calc()` once

Measured on production on 25 Oct 2026, during the audit of eleven database restarts in fourteen
days: the reconcile was the second-heaviest statement on the 2 GB box — 30 runs, 3.9 s mean, 9.7 s
max, 164,327 blocks read. EXPLAIN of the 20261023190000 body showed two
"Function Scan on crm_agent_crm_ids_calc" nodes, one per `except` arm, because a function with a
SET clause is never inlined; and a run that found a difference then called `_rebuild()`, which read
`_calc()` a third time.

`20261025030000_crm_agent_crm_ids_reconcile_single_pass.sql` re-creates the reconcile under the same
name, signature, security and grants, so the `_run()` wrapper, its heartbeat and the cron job are
untouched. It reads `_calc()` once into a local `v_truth` array, both `except` arms diff the cache
against `unnest(v_truth)`, and a repair refills from the same array (`delete ... where true`, then
insert) instead of calling `_rebuild()`. `_rebuild()` stays for the backfill and for hand use.
Applied on staging (first run: 0 differences against 150 cache rows) and production (23:41 Cairo).
Pinned by `tests/crm-agent-crm-ids-reconcile-single-pass.test.ts`, which refuses a second `_calc()`
read, a `_rebuild()` call, an unqualified DELETE and a caught exception.
