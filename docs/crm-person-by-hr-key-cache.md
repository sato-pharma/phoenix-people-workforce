# The person-by-HR-id cache, and where the doors' planning time actually goes

Migration `20261023153000_crm_person_by_hr_key_cache.sql`, pinned by
`tests/crm-person-by-hr-key-cache.test.ts`. Module memory: `.claude/rules/crm-unified-doors.md`.

## What was there

Both union doors need "the one employee row for this HR id, whatever the casing". Seven sites needed
it — in `crm_visits_unified` the agent, partner slot 1, partner slot 2, the day-activity agent and
the two iReports360 name slots; in `crm_checkins_unified` the agent — and **each one carried its own
copy of the same subquery**:

```sql
select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
  from public.employees e
 order by upper(btrim(e.hr_id)), e.hr_id
```

The rule is not "the employee with this hr_id". It is *one row per case-insensitive hr_id, the lowest
`hr_id` winning the tie* — and it exists because two rows whose ids differ only in case would
otherwise double a visit outright. Seven copies of a rule is seven chances for six of them to drift.

It was also paid seven times per read: a `Sort` + `Unique` over all 220 employees, about 198 buffers
each, on every page of every door.

## What it is now

`public.crm_person_by_hr_key_calc(p_hr_key)` holds that body once. `public.crm_person_by_hr_key_cache`
is the 220-row table it fills, keyed on `hr_key` — so "one row per person" is now a PRIMARY KEY rather
than seven sites remembering to say `distinct on`. Both doors join the table. Nothing else about
either door changed: same columns in the same order, same `security_invoker`, same grants.

The cache carries the name twice on purpose. `full_name` is what `employees` holds; `full_name_nz` is
`nullif(btrim(full_name), '')`. The two iReports360 slots read `full_name_nz`, because
`case when agent_person.full_name_nz is not null` is what decides whether the vendor's own spelling of
the agent is kept — an employee whose name is an empty string must read as "no name on record". The
five Phoenix slots read the raw column. **Swap them and the door still runs**, which is why the test
pins each site by name.

**Since 2026-11-03 the two columns hold the DISPLAY name**, the nickname else the full name
(`20261103213631_crm_doors_name_people_by_their_display_name.sql`; owner: "One PR, legal stays"). The
column names did not change, so neither door's body did. Every CRM screen prints these columns, so they
all read the name the rest of the system shows. A paper that needs the legal name reads
`employees.full_name`, never a door.

**Staleness.** `employees` is the only input, and an `AFTER … FOR EACH STATEMENT` trigger on it —
insert, delete, or an update of `hr_id`, `crm_id`, `full_name` or `nickname` — rebuilds all 220 rows *through
`_calc()`* inside the writer's own transaction. A hire or a rename is therefore exact on the hot path.
`crm_person_by_hr_key_reconcile()` runs every 15 minutes on pg_cron as a safety net for a write that
bypasses the trigger (a TRUNCATE, a disabled trigger, a restore); it compares values, repairs, and
warns. If a name ever disagrees with `_calc()`, the cache is the suspect and `_calc()` is the truth.

## What it bought, measured on production

Nine interleaved runs of the old shape and the new against the same day, 23 October 2026, one day's
first page of `crm_visits_unified`, medians:

| | planning | execution | buffers |
| --- | --- | --- | --- |
| the old shape | 8.76 ms | 16.73 ms | 1,227 |
| the cache | 7.97 ms | 11.09 ms | 283 |

Byte-identical output across the swap: the md5 of every row of `crm_visits_unified` since 1 September
(25,038 rows) and of `crm_checkins_unified` over the same window (30,449 rows) is unchanged from the
reading taken immediately before applying.

## 🔴 Where the planning time actually goes — read this before trying to cut it again

The owner's instruction was *"cut the 22 ms planning time on crm_visits_unified"* (2026-10-23). Three
things are worth knowing before anyone spends another day on it.

**1. About 13 of those 22 ms were a cold catalog, not work the app pays.** Planning touched **2,274**
shared buffers on the first statement of a new connection and **39** on every statement after it. A
measurement taken through a fresh connection — which is what every Supabase MCP call is — therefore
reads roughly twice the planning time a warm pooled connection pays. Measure the second run, never the
first.

**2. The person subqueries were never the planning cost.** A `DISTINCT ON` subquery cannot be pulled up
into the parent join tree, so each of those seven was already an optimisation fence and never entered
the planner's search space. That is why replacing all seven with table joins moved planning by only
about 9% — while moving execution by 34%.

**3. What planning actually costs is the join-order search, and it is a database-wide knob.** Measured
the same way, on the same day:

| `join_collapse_limit` / `from_collapse_limit` | planning (visits) | execution (visits) |
| --- | --- | --- |
| 1 | 5.91 ms | 21.89 ms |
| 4 | 6.67 ms | 24.31 ms |
| **8 (today's default)** | **11.74 ms** | **24.47 ms** |
| 20 | 17.28 ms | 21.45 ms |

and on the check-in door, 8 → 4 took planning from 3.97 ms to 2.62 ms. So **4 halves the planning time
of both doors with no execution penalty in any run** — but `join_collapse_limit` is a planner setting,
not a property of a view. There is no way to scope it to one view: it would have to be set on the
database or on the role PostgREST connects as, where it governs **every** query the application makes,
including ones no one has measured. That is a decision for the owner, and it is deliberately **not** in
this migration.

🔒 **OWNER DECISION, 2026-10-23: it stays at 8. Settled — do not re-propose it.** He was shown the
table above and chose to leave the default alone: the knob would govern every query the application
makes, including ones nobody has measured, to save about 5 ms on two of them. A future session that
rediscovers the join-order search should write the finding here, not put the knob to him again.

**4. Planning is the smaller half anyway.** Reads of these two doors arrive through PostgREST
(`WITH pgrst_source AS (…)`), and `pg_stat_statements` has `track_planning` **off** here, so every
figure it reports is execution only. The heaviest statements naming these views average 48–420 ms of
execution each. Against that, 8–12 ms of planning is worth having but is never where the read goes.

## Rolling back

Re-apply the two `create or replace view` statements of
`20261022163000_phoenix_wins_the_old_crm_doors.sql`. That puts both doors back on the inline
subqueries and leaves the table, the trigger and the schedule in place doing no harm. Drop them
afterwards if the revert is final.
