# The hourly recovery undo log

**Production has no point-in-time recovery.** Seven daily backups are the whole story, and using
one means restoring it into a *separate* project to extract from. A bad `UPDATE` on payroll at 2pm
costs everything back to last night.

7-day PITR is ~$100/month and closes exactly that. The owner was shown the number on 2026-09-29 and
chose a **zero-cost** design instead. This is it.

## 🔴 What this is not

**An undo log, not a backup.** It lives inside the database it protects. It defends against a bad
write, a bad backfill, a bad migration. It does **not** defend against losing the project — that is
still the seven daily backups — and it covers **7 tables**, not the other ~420.

Anyone who reads this as replacing PITR has misread it.

## What it does

`pg_cron` runs `recovery.take_snapshots()` at **:05 every hour**. For each registered table it
builds a canonical JSON payload ordered by primary key, hashes it, and stores a copy **only if the
hash changed**. Unchanged hours write nothing at all.

**Observed, not assumed** — the first scheduled fire was watched rather than inferred:

```
cron.job_run_details   23:05:00 Cairo   status: succeeded
recovery.snapshot_runs 23:05:00 Cairo   checked 7 · changed 0 · purged 0
```

`changed: 0` is the cost model working: nothing had been edited since the previous capture, so the
hour cost nothing. Until that row existed the schedule was only a `cron.job` entry — `pg_cron`
raises no alarm if it never runs, which is exactly why the dead-man's switch below exists.

`pg_cron` is a Postgres extension, not a paid Supabase add-on, and nothing here uses GitHub Actions
minutes.

## What is protected

| Table | Rows | Payload | Versions kept |
| --- | --- | --- | --- |
| `public.salary_records` | 896 | 877 kB | 72 |
| `public.salary_batches` | 8 | 4,540 B | 72 |
| `public.employees` | 199 | 422 kB | 72 |
| `public.monthly_closing_publications` | 6 | 73 kB | 72 |
| `public.monthly_closing_locks` | 28 | **13 MB** | **12** |
| `au.monthly_targets` | 4,333 | 1,525 kB | 72 |
| `au.line_area_map` | 171 | 57 kB | 72 |

`monthly_closing_locks` carries `snapshot_breakdown jsonb` — a full closing breakdown per row — so
one version of it is 200× the next largest. It keeps 12 rather than 72, or it alone would drive the
global ceiling and evict the cheap, useful history of the other six. Add a heavy table by setting
`max_versions` in `recovery.protected_tables`, not by editing a function.

Measured after the first real run: the whole store is **2,336 kB on disk** (17 MB of logical JSON,
which TOASTs well).

## Retention, and the rule that matters

1. Keep each table's newest `max_versions` changed versions.
2. Plus any version flagged `keep_daily` — the first of a UTC day — for 30 days.
3. 🔴 **Never delete a table's newest version, at any age.** A purely time-based purge would delete
   the only copy of `au.line_area_map`, which changes about monthly. This is the rule that makes
   change-based storage safe.
4. Global ceiling of 512 MB, oldest first, still never a newest version.
5. `snapshot_runs` and `restore_preimages` keep 90 days.

Rules 1 and 2 stack, so **more than `max_versions` rows can legitimately survive**: with a cap of 2
the throwaway test above ended on three — v4 and v3 as the newest two, plus v1 carrying
`keep_daily` as that table's first capture of the UTC day. That is the design, not a leak; the
global byte ceiling is what bounds it.

6. 🔴 Every ordering is `(taken_at, id)`, never `taken_at` alone — see the incident below.

**Restore semantics fall out of hash-skipping:** *the state at time T is the newest snapshot at or
before T.* The gaps are correct, not missing — no snapshot between two points means the table did
not change between them.

### 🔴 The rule failed once, before it shipped — read this before changing any ordering

Exercising the purge on a throwaway table on 2026-09-29 (four changed versions, `max_versions = 2`)
kept **v1 and v2 — the two oldest** — and deleted v3 and v4. The live table held `v4`; the snapshot
ranked "newest" reported `v1`. **A restore to "now" would have written the original contents back
over the current ones.**

The cause was not the rule, which was written correctly from the first commit. It was that
`taken_at` defaulted to `now()`, and in Postgres `now()` is the **transaction** timestamp — every
snapshot taken inside one transaction carries an identical `taken_at`, `order by taken_at desc` is
then a tie, and `row_number()` assigned `rn = 1` to an arbitrary member. "Never purge rn = 1"
faithfully protected the wrong row.

Production never saw it: the hourly job runs each capture in its own transaction, so real
timestamps are distinct. It appears the moment two captures share a transaction — a manual
`take_snapshots()` beside the scheduled one, a backfill, any future caller that loops.

Fixed in `20260929203100_recovery_total_order_on_snapshots.sql` two ways on purpose:
`taken_at` now defaults to `clock_timestamp()`, which advances inside a transaction, **and** every
ordering tie-breaks on `id`, which is what protects rows already stored with tied stamps. Re-run
after the fix: rank 1 is `v4`, matching the live table.

**The lesson worth keeping: a correct ranking rule is worthless on a non-total order, and a
source-pinning test cannot see it.** The test asserted the `rn > cap` shape, which was present and
right the whole time. Only running the purge revealed it. If you change any `ORDER BY` here, keep
the `id` tiebreaker and run the purge against a throwaway table before believing it.

## Restoring

```sql
-- 1. What would change? Read-only, and the default.
select * from recovery.restore_table('public', 'salary_records', timestamptz '2026-09-28 14:00+00');

-- 2. Do it.
select * from recovery.restore_table('public', 'salary_records', timestamptz '2026-09-28 14:00+00',
                                     p_dry_run => false);
```

Applying takes a **pre-image of the current contents first**, into `recovery.restore_preimages` —
mandatory, because there is no PITR behind a restore that turns out to be the wrong call. Then, in
one transaction: `set constraints all deferred`, `delete`, and re-insert from the payload.

### Proven end to end, on production, 2026-09-29

Against a throwaway table in the `recovery` schema — nothing real was touched, and the table was
dropped afterwards:

```
seed                1=alpha, 2=beta, 3=gamma     -> snapshot taken
damage              delete id 2; set id 1 = 'CORRUPTED'
after the damage    1=CORRUPTED, 3=gamma
restore             applied: 2 rows replaced by 3
after the restore   1=alpha, 2=beta, 3=gamma     <- both the delete and the update undone
pre-image kept      [{"v":"CORRUPTED","id":1},{"v":"gamma","id":3}]
```

## Proven unreachable over HTTP, not just in the catalogue

Grants were checked in `pg_catalog` *and* probed with the live production `anon` key on
2026-09-29. The catalogue answer alone is not enough — a view with `security_invoker = true`
carries misleading `anon` privileges elsewhere in this database, so the only conclusive test is the
wire:

```
anon GET /rest/v1/recovery.table_snapshots    -> 404
anon GET /rest/v1/recovery.protected_tables   -> 404
anon GET /rest/v1/recovery.restore_preimages  -> 404
anon GET /rest/v1/table_snapshots             -> 404   (unqualified, in case of a search_path leak)
anon GET /rest/v1/protected_tables            -> 404
anon POST /rest/v1/rpc/phx_ci_recovery_health -> 401   42501 permission denied for function
```

**404, not 403** — without `USAGE` on the schema PostgREST does not know the tables exist at all,
which is the stronger of the two answers. Re-run this probe after any grant change here.

## Limits worth knowing before you rely on it

- **Single-table restore cannot fix cross-table consistency.** Restoring `salary_records` to Sunday
  while `salary_batches` stays at today is a coherent-looking, incoherent state. A real payroll
  rollback restores the batch and its records together.
- **Schema drift.** A column added after a snapshot restores as `NULL`, not its default. If it is
  `NOT NULL` the restore fails loudly — correct, but it means a snapshot older than the last schema
  change may need hand-editing.
- **Identity sequences are not reset.** After restoring a table with a generated key, check
  `setval` before the next insert.
- **Detection latency.** `scripts/check-schema-shape.ts` reads `public.phx_ci_recovery_health()` on
  its existing daily run, so a stopped snapshotter surfaces within 24 hours, not within the hour.
  Tightening that further would cost Actions minutes, which is the thing this design avoids.

## Where it lives

| | |
| --- | --- |
| Schema | `recovery` — no `USAGE` for `anon` or `authenticated`, so PostgREST cannot reach it |
| Created by | `supabase/migrations/20260929200500_recovery_snapshot_store.sql` |
| Per-table caps | `supabase/migrations/20260929201500_recovery_per_table_version_cap.sql` |
| Total ordering | `supabase/migrations/20260929203100_recovery_total_order_on_snapshots.sql` — must stay the LAST migration defining these functions |
| Schedule | `cron.job` → `phoenix-recovery-snapshot`, `5 * * * *` |
| Health, for CI | `public.phx_ci_recovery_health()` — service role only, counts and timestamps, never contents |
| Exempt from | `scripts/audit-backup-schemas.mjs` retention, deliberately — it is infrastructure |
