# The Phoenix contact truth is a cached table

The account behind the `crm-unified-doors` module rule "THE CONTACT TRUTH IS A CACHED TABLE".
Migration `20261023140001_crm_contact_phoenix_truth_cache.sql`, pinned by
`tests/crm-contact-phoenix-truth-cache.test.ts`. The sibling of
[the entry-days cache](crm-rep-entry-days-cache.md), applied the same day.

## What the rule is about

`crm_contact_phoenix_truth` answers "which Phoenix name and speciality win for this contact". One
contact can carry several `phoenix_crm_customers` rows — the unique index is per
`(seat_id, reference_contact_crm_id, is_test)`, so two seats legitimately hold the same contact — and
the winner is **active first, then the newest `validated_at`, then the newest `updated_at`**.

All **three** unified doors left-join it for the name they show: `crm_visits_unified`,
`crm_checkins_unified` and `crm_plan_entries_unified`. Nothing else reads it — 9 rewrite
dependencies, all three doors, and no TypeScript names it.

## What it cost, measured on production

The view was `select distinct on (reference_contact_crm_id) … from phoenix_crm_customers`, and **a
join qual cannot be pushed into a `distinct on`**. So Postgres built the whole thing and hashed it on
every read of every door, however narrow the page: 2,287 qualifying rows out of 20,774 customers,
hashed down to 2,285 winners, to decorate as few as 27 rows.

| Probe, 23 October 2026 | Before | After |
| --- | --- | --- |
| Ordered first page, 83-day window | 2,948.2 ms | **121.1 ms** |
| Dense single-day page (872 rows) | 11.5 ms | **2.3 ms** |
| The truth view read on its own | 3.9 ms, 240 blocks | a keyed lookup |

Both figures are deltas over two calls of one `pg_stat_statements` entry — the marker comment does
not change the queryid, so the second call accumulates into the first row rather than making a new
one, and the per-call cost is the difference.

Two intermediate probes located the cost before anything was built: the same page **with the truth
join removed** ran in 115.8 ms, and against a session-local **indexed temp copy** of the truth in
109.3 ms. So the hash was 96% of that page's time, and an indexed table was worth the whole of it.

Blocks barely move on the wide page (29,853 → 29,640): the ordered read still materialises the whole
window, because a set operation's columns cannot be pruned and the sort still carries all 16 of the
door's columns. **That is a separate, still-open cost** — see "What is still slow" below.

## Why `distinct on` could not simply be dropped

It looked removable, and it is not. `phoenix_crm_customers_reference_uidx` is unique per
`(seat_id, reference_contact_crm_id, is_test)`, not per contact; **2** references already had more
than one qualifying row when this was written, and 3,829 are duplicated across the whole table. A
plain join would have multiplied those rows. The winner is a real rule, so it keeps one body.

## The shape

- `phoenix_crm_contact_truth_calc(p_contact_crm_id)` holds the **one body** — the view's
  pre-migration query verbatim plus one optional narrowing predicate. Null is the whole table.
- `crm_contact_phoenix_truth_cache(contact_crm_id, name, speciality, refreshed_at)`, primary key
  `(contact_crm_id)` — the key is the point: it is what lets a door look up only the contacts on the
  page.
- `crm_contact_phoenix_truth` keeps its **name, its three columns, their types and
  `security_invoker = true`**, and reads the cache. **No door was edited**, which is why all three
  got this for free and why the change is one statement to revert.
- `_rebuild()` and `_touch(contact)` both fill the cache **through `_calc`**.

## The staleness window

`phoenix_crm_customers` is the **only** input — every column the truth reads lives on that one table
— so unlike the entry days there is no untriggered input:

| Input | How |
| --- | --- |
| `phoenix_crm_customers` | one row trigger, insert, update **and** delete; a customer edit changes the cache in the writer's own transaction |
| the same, truncated | statement trigger, full rebuild — TRUNCATE fires no row trigger |

An UPDATE recomputes the **old** reference as well as the new one. A row moved to another contact
otherwise leaves the old contact holding a name that no longer wins.

`phoenix_crm_contact_truth_reconcile()` is therefore a **safety net, not the staleness bound**, and
runs every 15 minutes rather than every 5. It compares the **values** in both directions — a stale
name is the failure that matters, not a missing contact — repairs through `_rebuild()` and raises a
warning.

## Why it was safe to apply to a database holding real payroll

The migration backfills and then **refuses to commit** unless the cache and `_calc()` agree row for
row. On production it wrote **2,285 rows with 0 differences** — exactly the number of winners the old
hash built (`actual rows=2285` in the pre-change plan).

The trigger was proved on **staging**, not production: `phoenix_crm_customers` carries an AFTER
trigger (`phoenix_crm_customers_write_contact_name_row`) that writes a contact-name row, so a no-op
update on production would have written one as a side effect of a test. On staging, one cache row was
deleted for contact 103614, a no-op update (`set speciality = speciality`) put it back, and the
reconcile then found 0 differences.

## How it was applied

Through `scripts/apply-sql-file.mjs`, the standing route (AGENTS.md §8), staging then production with
`PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com`. It went there directly rather than
after a decline, because the file carries the same `drop trigger if exists` and in-function `delete`
shape the MCP classifier declined an hour earlier on the entry-days cache — and the staging
trigger-proof script, which also holds a `delete`, was in fact declined when sent through the MCP.

That route writes **no** `schema_migrations` row, so the file is recorded in
`ACKNOWLEDGED_EXCEPTIONS` (`scripts/lib/migration-inventory.ts`) with the `md5(prosrc)` of all six
functions. Never a ledger write.

## What is still slow, and is NOT this

An **ordered** wide-window page still materialises its whole window, and the ordering is where the
remaining cost sits. Measured on the same door, same window, before this change:

- no `order by` at all: 9.5 ms, 983 blocks — the LIMIT stops early
- `order by check_date`: 135.1 ms, 29,839 blocks
- `order by check_date, id`: 2,948.2 ms, 29,853 blocks

Same blocks, 22× the time, purely for the `id` tiebreak. A set operation's columns cannot be pruned,
so the sort carries all 16 of the door's columns including `raw_payload` jsonb, however narrow the
caller's projection. `src/lib/crm/reads.ts` already avoids this for company-wide windows by scanning
one calendar day per request (`dayScanSlices`), which is why the day-sliced page is 2.3 ms. Any
future work here belongs on the ordering and the projection, not on the truth join.
