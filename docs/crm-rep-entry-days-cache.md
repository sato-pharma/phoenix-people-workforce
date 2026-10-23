# The Phoenix entry days are a cached table

The account behind the `crm` module rule "THE ENTRY DAYS ARE A TABLE, AND `_calc()` IS THE ONE BODY".
Migration `20261023091035_phoenix_crm_rep_entry_days_cache.sql`, pinned by
`tests/phoenix-crm-rep-entry-days-cache.test.ts`.

## What the rule is about

"Phoenix wins the day" (owner, 2026-10-16) drops a rep's iReports360 rows on any day he also has a
Phoenix entry. `phoenix_crm_rep_entry_days()` is its one definition — anti-joined by
`crm_visits_unified` and `crm_checkins_unified`, and read by `phoenix-kpi-data.ts`,
`phoenix-team-starts.ts` and `phoenix-vendor-leftovers.ts`.

Until 23 October it recomputed every entry day from all of Phoenix CRM's history on every read of
either door.

## What it cost, measured on production

One first-page read of `crm_visits_unified` for a single day inside a 23-day window, 23 October 2026:

| | Before | After |
| --- | --- | --- |
| The `entry_days` step | 35.2 ms, 4,509 buffers | **0.99 ms, 70 buffers** |
| Execution | 79.4 ms | **30.2 ms** |
| Planning | 49.2 ms | **22.6 ms** |
| Buffers, whole read | 5,888 | **1,587** |
| Rows returned | 123 | 123 |

The `entry_days` CTE was 44% of the execution and 77% of every buffer touched, to produce 542 rows
describing 16 days. It is paid on **every** read of both doors, and a company-wide window is
deliberately read one calendar day per request (`reads.ts`, `dayScanSlices`, which exists because an
ordered scan of a whole window hit the 8-second statement timeout on 14 and 16 September), so a
23-day window paid it 23 times.

`pg_stat_statements` since the 22 October restart, before the change: 20,610 calls naming the five
CRM unified views, 3,074 s of 5,582 s — **55.1% of all execution time on the production database**.

It also grew with adoption: the function read `phoenix_crm_visits` (4,225 rows then) in full, plus its
unplanned and recording joins, every time. This migration continues `20261023040102`, which made the
customer join removable and took the same function from 18,025 buffers to about 4,500.

## The shape

- `phoenix_crm_rep_entry_days_calc(p_hr_key, p_day)` holds the **one body** — the pre-migration body
  verbatim plus two optional narrowing predicates. Both null is the whole history.
- `phoenix_crm_rep_entry_days_cache(hr_key, entry_day, agent_crm_id, refreshed_at)`, primary key
  `(hr_key, entry_day)`, plus a partial index on `(agent_crm_id, entry_day)` for the second
  anti-join — the one matching vendor rows whose agent has no `hr_id` at all.
- `phoenix_crm_rep_entry_days()` keeps its name, arguments, three columns, `STABLE SECURITY DEFINER`
  and `rows 400`, and reads the table. **No view changed**, so all five existing callers got it free.
  The `rows 400` estimate was kept deliberately, so no plan anywhere changes shape over a new one.
- `_rebuild()` (whole table) and `_touch(hr_id, day)` (one key) both fill the cache **through
  `_calc`**, which is what keeps one definition of the rule.

## The staleness window

Six things decide the answer. Four are trigger-watched, on insert, update **and** delete, so a rep
saving a visit changes the cache in his own transaction:

| Input | How |
| --- | --- |
| `phoenix_crm_visits` | row trigger, recomputes that rep-day |
| `phoenix_crm_day_activities` | row trigger, recomputes that rep-day |
| `phoenix_crm_unplanned_visits` | row trigger via the visit — an approval decision changes countability without touching the visit |
| `phoenix_crm_visit_recordings` | row trigger via the visit, same reason |
| `phoenix_crm_team_starts` | statement trigger, **full rebuild** — a start re-dates whole teams at once and has no single key |
| `employees`, `au.seats` | **not triggered** — the 5-minute reconcile is their bound |

An UPDATE recomputes the **old** key as well as the new one. A visit moved to another day or
re-assigned otherwise leaves its old rep-day claiming an entry that no longer exists, which silently
drops that day's iReports360 rows for ever.

`employees` (only feeds `agent_crm_id`) and `au.seats` (which seats are REP under a started team) are
left to `phoenix_crm_rep_entry_days_reconcile()`, scheduled `*/5 * * * *` as
`phoenix-crm-rep-entry-days-reconcile`. It compares both directions with `EXCEPT`, **rebuilds** on any
difference and raises a warning. That was the deliberate trade: a cross-schema trigger on `au.seats`
would fire on every seat write in the platform, and the reconcile covers every input rather than only
the ones somebody remembered to enumerate.

**So a figure that disagrees with `phoenix_crm_rep_entry_days_calc()` means the cache, not the rule.**
`select public.phoenix_crm_rep_entry_days_reconcile();` returns the number of differing rows and
repairs them.

## Why it was safe to apply to a database holding real payroll

The migration backfills and then **refuses to commit** unless the cache and `_calc()` agree row for
row. On production it wrote **542 rows with 0 differences**, against the 542 the live computation
returned beforehand (pre-image `md5(prosrc)` of the old function: `e1dd0c8255019f15149563b28bf6b68f`).

The trigger was then proved by breaking the cache on purpose: one row deleted for `b-124`/2026-10-22,
a no-op update on that day activity (`set activity_date = activity_date`, changing no value) restored
it, and the reconcile then found 0 differences. `phoenix_crm_day_activities` carries no other trigger,
which is why the probe went through it rather than through `phoenix_crm_visits`, whose own BEFORE
triggers can alter or refuse a row.

## How it was applied

The Supabase MCP **declined** `apply_migration` — the file carries `drop trigger if exists` and a
`delete` inside a function body, which the classifier reads as the statement being run. It went
through `scripts/apply-sql-file.mjs`, the standing route (AGENTS.md §8), with
`PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com` for production.

That route writes **no** `schema_migrations` row on either project, so the file is recorded in
`ACKNOWLEDGED_EXCEPTIONS` (`scripts/lib/migration-inventory.ts`) with the `md5(pg_proc.prosrc)` of all
nine functions — byte-for-byte identical on staging `cifwmndunmlxjhyjugxa` and production
`ozucdzovmcqvepbozvqf`, same file, same lengths. Never a ledger write.

Staging holds no Phoenix CRM team starts, so its backfill wrote 0 rows: the data proof is
production's, which is the ordinary case of "staging cannot rehearse a production shape".

## Rollback

One statement puts every reader back on the live computation and leaves the table, the triggers and
the schedule in place doing no harm:

```sql
create or replace function public.phoenix_crm_rep_entry_days()
 returns table(hr_key text, agent_crm_id bigint, entry_day date)
 language sql stable security definer rows 400 set search_path to 'public'
as $$ select c.hr_key, c.agent_crm_id, c.entry_day from public.phoenix_crm_rep_entry_days_calc() c $$;
```

Reverting the pull request does not reverse an applied migration — only another migration does.
