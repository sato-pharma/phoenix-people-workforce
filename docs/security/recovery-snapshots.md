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
takes a streamed fingerprint (one md5 per row, in primary-key order), and builds and stores a
canonical JSON copy **only if the fingerprint changed**. Unchanged hours write nothing at all, and
since 2026-10-16 they build nothing either — see "The streamed fingerprint" below. Until then every
hour built every table's whole copy just to hash it.

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

### The schedule is in a migration — it used not to be

Until 2026-10-08 everything about this store was in a migration **except the one thing that makes it
run**. `20260929200500_recovery_snapshot_store.sql` creates the schema, the registry and
`take_snapshots()`; the hourly `cron.job` entry had been created by hand. So a restored, recreated
or region-moved database came back with the store fully deployed and never running — 7 tables
registered, the function present and correct, and nothing calling it. That is the "looks like
protection" state the dead-man's switch below exists to catch, and it is exactly what staging reads
today.

`20261008140000_schedule_recovery_snapshot_cron.sql` closed it, at the owner's instruction. Two
properties make it safe to re-apply against a live production:

- **It schedules BY NAME.** `cron.schedule('phoenix-recovery-snapshot', …)` updates the existing job
  of that name for the same user rather than creating a second one, so re-applying does not stack a
  second hourly caller. Verified on production the day it shipped: before and after, **one** job of
  that name, **jobid 1** unchanged, and `cron.job_run_details` still holding all **206** runs
  (that table is keyed by jobid, so preserving the id is what preserves the history). The migration
  refuses outright if it ever finds two jobs of that name, and re-asks `cron.job` afterwards so a
  schedule that did not take fails the migration instead of passing quietly.
- **It is guarded on `pg_extension`.** Where `pg_cron` is absent it raises a warning and moves on —
  which matters beyond tidiness, because a failing `staging-migrate` withholds the production
  deploy. It does **not** install the extension, which is why staging needed the owner's word
  below. On the day it shipped, staging had no `pg_cron` and the migration applied there cleanly
  through this branch, scheduling nothing.

Where `pg_cron` is absent the schedule is therefore still missing, which is the one reachable way
into `recovery_never_ran` — so that verdict's message says to install `pg_cron` and re-apply this
migration, not to schedule anything by hand. Migration plus gate is the whole loop. Pinned by
`tests/schema-shape-recovery-health.test.ts`.

### Staging runs the store too, since 2026-10-08

The owner's decision, taken the same day: *"enable pg_cron on staging and re-apply the recovery
cron migration"*. Left alone, the gate would have reported `recovery_never_ran` against staging on
every nightly run for ever — correctly and permanently, which is how a real alarm on production
gets trained out of people.

`create extension if not exists pg_cron` on staging installed **1.6.4** (extension namespace
`pg_catalog`, Supabase's convention; `cron.job` is the same shape as production's). The migration's
body was then re-run there — through `execute_sql`, deliberately **not** a second
`apply_migration`, because staging's ledger already holds a `schedule_recovery_snapshot_cron` row
from the run that skipped, and a second row for one migration buys nothing. Staging now holds
exactly **one** `cron.job` row: jobid 1, `phoenix-recovery-snapshot`, `5 * * * *`,
`select recovery.take_snapshots();`, `postgres`, active.

🔴 **Retention is NOT scheduled on staging and must not be.** The retention job's own migration
(`20261004041000`) is guarded the same way and skipped there when it was applied, so its ledger row
is already present and nothing re-runs it — but a `supabase db push` that replays that file would
now find `pg_cron` installed and start **pruning staging's rows** on a schedule nobody asked for.
Enabling the extension changed the blast radius of every `pg_cron`-guarded migration in the repo,
not only this one.

The store was then proven against staging's real data shapes rather than assumed — the first call
returned `checked 7 · changed 7 · purged 0 · error null`, 7.67 MB, and
`public.phx_ci_recovery_health()` reads all 7 tables `ever_captured: true` with one snapshot each.
`changed: 7` is a first capture, not churn; the hours after it cost nothing unless a table's
contents move.

🔴 **`create extension` succeeding does not prove the scheduler RUNS**, and that is the failure this
whole page is about, one layer down: pg_cron needs its background worker, and an extension that
installed while nothing fires is the same "deployed and never running" shape wearing a different
hat. So it was measured rather than inferred — a throwaway `* * * * *` job (`select 1`) scheduled at
11:27:14 UTC, which fired at **11:28:00.149 UTC, `status: succeeded`**, and was unscheduled again.
Reading `cron.job_run_details` a few seconds after the minute turned returned **zero rows**, which
is the trap: the empty read looks exactly like a dead worker. Give it the next whole minute before
concluding anything.

A manual call proves the function; only a fired job proves the schedule. Do both.

### The streamed fingerprint, since 2026-10-16

**Why it changed.** The first body answered "has this table changed?" by running
`recovery.canonical_payload()` on all seven tables every hour, then casting each payload to text
twice — once for its size, once for `md5`. `monthly_closing_locks` had grown to **28,457,501 bytes**
(53 rows) by 2026-10-16, more than double the 13 MB in the table below, so every :05 held a ~28 MB
jsonb plus two ~28 MB strings in one backend on a **2 GB** compute, whether or not anything had
changed. The longest runs were the minutes production stalled:

| Run (Cairo) | Took | What production did in the same minute |
| --- | --- | --- |
| 2026-10-08 16:05 | 50.4 s | server renders timing out at 16:06 ("Supabase request timed out.") |
| 2026-10-10 11:05 | killed | the instance restarted at 11:05:48, 48 s into the run (`cron.job_run_details`: `server restarted`) |
| 2026-10-11 13:05 | 36.1 s | edge requests fell from ~360 to 26-32 per 10 s between 10:05:10 and 10:05:30 UTC |
| 2026-10-14 17:05 | 45.2 s | zero edge requests completed 14:05:20-14:05:30 UTC; PostgREST lost its pool (PGRST001) and reconnected at 14:05:44, one second before the run ended |

Overnight the same function took 3.6-5.5 s. Those bursts are what the Error Monitor showed as React
error **#441** (a server render that threw "Supabase request timed out."), **#412** and
**PGRST002**. Seen together is not proof the run is the whole cause — the hard instance restarts on
10, 11 and 12 October are host-level and Supabase's to explain (the memory note
`a-production-postgres-crash-restart-wears-cloudflare-codes`) — but it was the one piece of hourly
work that scaled with the largest table, and it no longer has to.

**How it works now** (`supabase/migrations/20261016103901_recovery_snapshot_streamed_fingerprint.sql`):

- `recovery.fingerprint_table(schema, table, pk[], with_payload)` reads the table once and returns
  the row count, the exact byte size the payload would have, and the fingerprint
  `'r2:' || md5(string_agg(md5(row_json::text) order by pk))`. Only when asked does it also return the
  payload itself, identical to `canonical_payload()` — and then all four come from **one statement**,
  so the count, size and fingerprint stored beside a copy always describe that copy.
- The size is the sum of the row texts plus `[`, `]` and `, ` between rows, which is byte-identical to
  `octet_length(payload::text)`, so the 64 MB ceiling still means what it did. The payload is never
  cast to text.
- Two `OFFSET 0` fences keep the planner from evaluating `to_jsonb(t)` and its text once per
  reference. They are load-bearing; the test counts them.
- `take_snapshots()` calls the fingerprint without the payload, and calls it again with the payload
  **only inside the changed-table branch**. An unchanged hour holds one row at a time.

**The hash scheme moved, and nothing was re-captured for it.** A version stored before 2026-10-16
carries `md5(payload::text)`, which a streamed fingerprint cannot equal. The first run afterwards
re-fingerprinted each table's newest stored version from its own payload
(`recovery.payload_fingerprint(jsonb)`) and wrote the `r2:` value onto that row — so an unchanged
table read as unchanged, and no duplicate copy evicted real history from `monthly_closing_locks`,
which keeps only 12.

**Proven, not assumed.**

- Before writing it, on production, read-only: the streamed fingerprint of live
  `public.salary_batches` and the fingerprint recomputed from its newest stored payload were identical
  (`fa18d14e…`), and the size formula gave 5,060 = `octet_length(payload::text)`.
- On staging, against a throwaway table: an unchanged run stored nothing; an edit was captured with a
  payload equal to `canonical_payload()`; hash = `payload_fingerprint`, bytes = `octet_length`
  including a non-ASCII value; an empty table gave `[]`, 2 bytes. The probe tables were removed after.
- On production, the first scheduled run (2026-10-16 06:05 Cairo, including the one-time upgrade):
  **checked 7 · changed 0 · error none · 2,074 ms**, against 5,509 ms the hour before. All seven
  newest rows carry `r2:` hashes, `salary_batches` reads `r2:fa18d14e`, and the store still held 129
  versions — nothing re-captured.
- Production and staging carry byte-identical bodies (`md5(prosrc)` of `take_snapshots` is
  `1c8acd19…` on both).

**Rollback:** re-run the `take_snapshots()` definition from
`20260929203100_recovery_total_order_on_snapshots.sql`, then drop the two helpers. The old body reads
every `r2:` hash as a change and captures each table once more — one extra version per table, nothing
lost.

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

**Re-measured 2026-10-16** (the newest stored version of each): `salary_records` 989 rows / 991 kB ·
`salary_batches` 9 / 5,060 B · `employees` 216 / 560 kB · `monthly_closing_publications` 9 / 151 kB ·
`monthly_closing_locks` 53 / **28.5 MB** · `monthly_targets` 4,615 / 1.66 MB · `line_area_map` 176 /
63 kB. The store's logical total was 346,994,978 bytes across 129 versions, most of it
`monthly_closing_locks`. That is the JSON text size; the 512 MB ceiling below measures the table on
disk (`pg_total_relation_size`), which TOAST compression keeps far smaller — **44 MB** the same
morning.

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
| Total ordering | `supabase/migrations/20260929203100_recovery_total_order_on_snapshots.sql` — whichever migration defines each of the three functions LAST must carry its id tiebreak; `tests/recovery-snapshots.test.ts` checks that per function |
| Streamed fingerprint | `supabase/migrations/20261016103901_recovery_snapshot_streamed_fingerprint.sql` — `fingerprint_table`, `payload_fingerprint`, and the current `take_snapshots()` |
| Schedule | `cron.job` → `phoenix-recovery-snapshot`, `5 * * * *`, created by `supabase/migrations/20261008140000_schedule_recovery_snapshot_cron.sql` |
| Health, for CI | `public.phx_ci_recovery_health()` — service role only, counts and timestamps, never contents |
| Exempt from | `scripts/audit-backup-schemas.mjs` retention, deliberately — it is infrastructure |
