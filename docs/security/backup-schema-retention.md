# When a backup schema goes

`backup-table-placement.md` says a snapshot goes in its own dated schema, and that "dropping the
snapshot is the real end state". It never said **when**, so nothing ever did.

**Rule: a snapshot schema is kept 90 days from the date in its name, then it is proposed for
dropping. Nothing is ever dropped automatically.**

```bash
node scripts/audit-backup-schemas.mjs                     # production
node scripts/audit-backup-schemas.mjs --database staging
node scripts/audit-backup-schemas.mjs --retention-days 60
```

Exit `0` = nothing has expired, `2` = expired schemas found, `1` = error. The script prints the
`drop schema` statements for the expired ones; a human runs them.

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
