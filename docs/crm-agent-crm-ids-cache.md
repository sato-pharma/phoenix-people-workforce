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
  rebuilds on any difference and raises a warning. Scheduled `*/15 * * * *` as
  `crm-agent-crm-ids-reconcile`.
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

What the drop did buy is real and small — 2.8 MB back and one less index maintained on every
insert into a 1.6-million-row table. **It was applied to PRODUCTION only; staging still carries the
duplicate index.**

A related dead end, for anyone measuring this again: a hand-written `with ids as materialized (…)`
form measures nothing. The planner cannot push `= any(ids.a)` down, falls back to
`ireports360_visits_visit_date_idx` and scans the whole table (1,035 ms). Only a literal array
reproduces the live plan.

## 🔴 The 15-minute reconcile is the staleness bound, not a safety net

`crm_person_by_hr_key_cache` hangs an AFTER STATEMENT trigger on `employees`, its one input, and
its reconcile is a safety net. **This cache has no such trigger and cannot have one**:
`crm_visits_unified` draws on ~10 input tables. A pair can be up to 15 minutes old.

That is safe for THIS read, and only because of what the read is for. A pair enters the set when a
rep first records a visit under a CRM id. A departed rep records no new visits, so a departed
person's pair set is historical and frozen. The only pair a 15-minute window can miss belongs to
someone whose FIRST EVER visit landed in the last 15 minutes — who is, by construction, active, and
therefore not in the question being asked.

**Re-check that argument before reusing this cache for anything else.**

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
`select cron.unschedule('crm-agent-crm-ids-reconcile')` and drop the table and the three functions.
Nothing else reads any of them, and `src/lib/crm/reads.ts` needs no change either way.
