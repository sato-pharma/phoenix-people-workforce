# When a backup schema goes

`backup-table-placement.md` says a snapshot goes in its own dated schema, and that "dropping the
snapshot is the real end state". It never said **when**, so nothing ever did.

**Rule: a snapshot schema is kept 90 days from the date in its name, then it is put to the owner,
and it is proposed for dropping only once his decision for THAT schema is recorded. Nothing is ever
dropped automatically, and nothing is dropped on age alone** (since 2026-11-13; see
"The owner decides each one" below).

```bash
node scripts/audit-backup-schemas.mjs                     # production
node scripts/audit-backup-schemas.mjs --database staging
node scripts/audit-backup-schemas.mjs --retention-days 60
```

Exit `0` = nothing has expired, `2` = expired or undecided schemas found, `1` = error. The script
prints the `drop schema` statements only for the schemas the owner decided should go; a human runs
them.

## The owner decides each one

Enterprise audit 2026-11-13, REC-040: *every snapshot schema past 90 days has a recorded decision
before anything is dropped.* Until then this script printed a drop statement for any schema past
the window. Now the verdict past 90 days comes from
[`scripts/backup-schema-decisions.json`](../../scripts/backup-schema-decisions.json), one entry per
schema, never a pattern:

| His decision | Verdict past 90 days | What the script prints |
| --- | --- | --- |
| none recorded | `UNDECIDED` | no drop statement; "NEEDS THE OWNER" — put it to him |
| `keep` (no `until`) | `PROTECTED` | nothing, for good |
| `keep` with `until` | `PROTECTED` until that date, then `UNDECIDED` again | a keep that runs out goes back to him, never straight to a drop |
| `drop` | `EXPIRED` | the drop statement |
| `export-then-drop` | `EXPIRED` | `NOT YET: export it first` until the export's `manifest.json` exists, then the drop statement |

Every entry carries `decidedOn`, `decidedBy`, `why` and the review sheet that put it to him
(`sheet`); `readDecisions()` refuses an entry without them. A decision never beats a live
dependency (a foreign key into the schema still makes it `PINNED`), and never drops a schema
before its 90 days (a decision on a young schema only adds a note).

**How he is asked.** A review sheet per month lists the schemas that reach 90 days in it, grouped by
what they hold, with a recommendation each — the first was "Snapshot review — November 2026" (nine
schemas, all decided export-then-drop on 2026-11-13). Each answer is written into the decisions
file by schema name, in a pull request.

**Export, then drop.** `node scripts/export-backup-schema.mjs <schema>` reads production only, and
only a schema decided `export-then-drop`. It writes one CSV per table and a `manifest.json` (rows,
columns, bytes, SHA-256, the production ref, the export time, the decision) to
`PHOENIX_SNAPSHOT_EXPORT_DIR`, else `snapshot-exports` beside the repository. That folder is
outside every checkout on purpose: the repository is public and these files hold real business
data, so an export is never committed. The drop itself is still a dated migration, announced on
the day (AGENTS.md §8), with the manifest's table list in its header.

## What it looked like without a rule

Measured on production, 2026-09-29:

| | |
| --- | --- |
| Non-standard schemas | **99** |
| Their total size | **77.4 MB** — 3.2% of a 2,499 MB database |
| Oldest | `ez_split_backup_20260826`, 34 days |
| Accumulating at | roughly three a day |
| Ever dropped | one, `sales_ops_backup_20260830` |

**Storage is not the problem and never was.** 77 MB is noise. The problem is that the population
has no ceiling: every change that deserves a pre-image adds one, nothing removes one, and the
99 are already enough that no human reads the list — which is how
`deductions_governance_backup_20260830` sat there for a month with a live foreign key into it
while being indistinguishable, by name, from 98 schemas that are inert.

## Why 90 days

The argument for something much shorter is real. A pre-image exists to undo a change; once the
monthly closing that the change fed is published and announced, it can never lawfully be used,
because **a published month is never corrected** (AGENTS.md §4). That reasoning lands at 35-60
days.

It is 90 anyway, because the two mistakes do not cost the same:

- Keeping a dead schema too long costs a few megabytes, on a database where **all** of them
  together are 3.2%.
- Dropping a live one too early costs data with **no point-in-time recovery** behind it. Seven
  daily backups are the entire recovery story, and recovering from one means restoring it into a
  separate project to extract from — never in place.

So the number sits where it cannot plausibly be the reason a rollback was impossible. Its job is
to cap accumulation at ninety days, not to reclaim disk. Lower it with `--retention-days` once a
cycle has run and nothing was missed.

**The immediate effect of this policy is zero drops.** The oldest schema on production is 34 days
old, so nothing expires until late November. That is the policy working, not failing.

## What is never dropped, whatever its age

The order the classifier checks these in **is** the safety property — a live dependency is tested
before age, so nothing is ever called expired while something references it.

1. **A live application schema.** `analytics` (26 views, read by eight public functions) and
   `private` (14 security-definer helpers).
2. **Anything with a live dependency**, computed live on every run, never from a list:
   - a foreign key from outside pointing in,
   - a view or materialised view built on one of its tables,
   - a function whose body holds a schema-qualified `<schema>.` reference.

   Today that is exactly one schema: `public.private_calendar_no_activity_clarifications` holds a
   foreign key into `deductions_governance_backup_20260830`. A name-and-age sweep would take
   production's referential integrity with it.
3. **Migration-owned schemas.** `internal` (in the schema baseline) and `_au_rollback` (named by
   `20260719220000_advisor_center_primary_keys`).
4. **The owner's own decisions**, which have conditions rather than dates and so never expire on
   their own: `hr_backup_20260829` and `crm_backup_20260828` (C13 pre-images, retire only once
   September payroll proves the 08-29 fixes) and `delta3_defer_backup_20260829`.

Categories 1, 3 and 4 are a list in `scripts/audit-backup-schemas.mjs`; category 2 is measured.
**Adding to the list is how you hold something back** — never by editing the age.

## The bare-word trap

The dependency check matches `<schema>.`, with the dot, not the bare schema name. Matching the
bare word was tried first and is useless here: several schemas are named after ordinary English
words, so `internal` matched the word "internal" inside Supabase's own `realtime.apply_rls` and
`storage.search`, and was reported as pinned by two functions with no connection to it. That is
the right bucket for a wrong reason, which is worse than not checking — it hides the real
classification and trains you to skim the reasons.

## Undated schemas

A schema with no date can never expire, so the rule cannot reach it. Five on production carry no
date in the name, and between them they held 43% of all backup bytes.

Three of the five are rescued by their **table** names —
`ops_backup.v2_vacation_requests_a10_pre_paidfix_20260917` dates the schema even though
`ops_backup` does not — so the script falls back to the newest date among the tables. The newest
is the right one: a schema reused for a later snapshot is only as expired as its latest contents.

What survives that is reported under **LOOK** and never auto-proposed. Today that is
`plan_backups`, whose single table `deleted_employee_plans` names no date at all. Fix one of
these by dating it or dropping it deliberately — not by guessing an age for it.

## The snapshot that has no schema at all

🔴 **Added 2026-10-13, and it was the bigger hole.** Everything above sweeps non-standard
**schemas**, and `public` and `au` are both standard — so a pre-image taken as a *dated table*
beside the live data was outside this script entirely. It had no schema of its own to age out, so
it could never expire, under any retention.

Measured on production the day it was found, with the new pass: **58 such tables, 5.5 MB**, across
`public` (34) and `au` (24) — a population this sweep had never once reported. Every one of the 58
is a genuine snapshot by name (`bak_…`, `…_backup_…`, `…_preimage_…`, `…_snapshot_…`), none was a
false positive, the oldest was 47 days (`au.zz_brick_backfill_snapshot_20260827`) and so none had
expired at 90 days. It surfaced while triaging the Supabase advisor's `rls_enabled_no_policy`
count, which two of them had just pushed from 210 to 212 under a note saying the snapshots "leave
the count by themselves as their schemas pass retention" — for these there was no schema to pass.

A table is claimed only when it carries a **real date** *and* either ends in that date
(`address_brick_moves_20261013`) or names a snapshot word as a whole underscore-delimited part
(`bak_20261008_luxor_notes_fix`). Both halves matter:

- **No date, no claim.** `database_restarts` is a live log; there is nothing to age.
- **Parts, never substrings** — the same trap as the bare-word one above. `pre` inside
  `prescriptions` and `old` inside `household` must not make live data look like a snapshot.
- **A partitioned child is excluded in SQL** (`relispartition = false`), because a daily partition
  like `events_20261013` is the one shape the name test genuinely cannot tell apart.

The verdict ladder, the dependency checks and the 90 days are the schema ones, unchanged — a
foreign key, view or function that names the table beats its age, which matters *more* here than
for a schema, because the live tables sit beside it. The emitted statement is
`drop table if exists <schema>.<table>;` with **no `cascade`**: a snapshot schema is dropped whole,
but a lone table in `public` could have had something come to depend on it, and a statement that
refuses is the right answer at that moment.

The real fix for one of these is still
[`backup-table-placement.md`](./backup-table-placement.md) — put the snapshot in its own dated
schema. Until then it is swept where it lives instead of being invisible.

## Why it will not drop anything for you

There is no `--apply`, and there should not be. A schema dropped in error is recoverable for
seven days and only by restoring a backup into a separate project. That is not a risk worth
automating away for 77 MB. Re-read the dependency checks at the moment you drop, not from a
report written earlier — that is the procedure
[`20260929155251_drop_sos_analysis_20260913.sql`](../../supabase/migrations/20260929155251_drop_sos_analysis_20260913.sql)
records, including the full manifest of what was in the schema, because after the backup window
that comment is the only remaining evidence of it.

## What the access statistics cannot tell you

`pg_stat_all_tables.last_seq_scan` looks like the perfect test — has anything read this schema
since it was made? It is not usable here. Statistics accumulate only since the last postmaster
start, which on this database was **four days** before the audit, so "92 schemas have never been
read" was a statement about a four-day window, not about their lifetime. It reads exactly like
strong evidence and is nearly worthless. Age and dependencies are what the rule uses.
