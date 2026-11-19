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
schemas), the second "Snapshot review — December 2026" (92 schemas in four groups); all 101 were
decided export-then-drop on 2026-11-13. Each answer is written into the decisions
file by schema name, in a pull request.

**19 November 2026: the last four.** After the 101, a full inventory of production (164 non-standard
schemas) left exactly four with no decision, and the owner answered all four in chat, each
"export, then drop":

| Schema | What it holds | Why it was undecided | Reaches 90 days |
| --- | --- | --- | --- |
| `crm_backup_20260828` | CRM brick resolutions before the 28-29 Aug fixes | exempt: kept until September payroll proved the fixes | 26 Nov 2026 |
| `hr_backup_20260829` | hire-date and probation rows before the 29 Aug fixes | the same exemption | 27 Nov 2026 |
| `plan_backups` | one weekly plan (week 39), deleted 26 Sep | no date in any name | 25 Dec 2026 |
| `zz_search_proof` | a scratch search-speed test from October, no business data | no date in any name | 21 Jan 2027 |

September payroll was published on 9 Oct and October on 14 Nov, so the two C13 pre-images' condition
was met; they left the exemption list (see "What is never dropped" below). The two undated ones are
aged by a recorded day, below.

**`dated`: the day a snapshot was taken, recorded by hand.** A schema whose name and table names
carry no date is `UNDATED` for ever, so a decision on it could never take effect. An entry may carry
`dated: "YYYY-MM-DD"`, with the evidence for that day in `why`, and `classify()` ages the schema from
it. It is a fallback only: a date in the schema or table names always wins, so a stray `dated` can
never make a dated schema look older than it is. `readDecisions()` refuses anything but one real day
in that exact shape, and the report says `dated … by record, not by name` wherever it was used.

- `plan_backups`: `2026-09-26`, from its one row's own deletion time, 25 Sep 22:12 UTC (26 Sep in
  Cairo).
- `zz_search_proof`: `2026-10-23`, from migration `20261023043536`, the first that names it (it pinned
  `zz_search_proof.run_phase`'s search path).

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
   their own: `delta3_defer_backup_20260829` (it holds `line_area_map_pre`, his standing keep).
   `hr_backup_20260829` and `crm_backup_20260828` were here until 19 Nov 2026 on the condition "retire
   only once September payroll proves the 08-29 fixes"; that condition was met and he decided both
   export-then-drop. An exempt schema is `PROTECTED` whatever its decision says, so a decided schema
   must never be put back on this list.

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

What survives that is reported under **LOOK** and never auto-proposed. Fix one of these by dating it
or dropping it deliberately — not by guessing an age for it. Dating it means a decision entry with
`dated` and the evidence for the day (see "The owner decides each one"). That is how `plan_backups`
(whose single table `deleted_employee_plans` names no date) and `zz_search_proof` were dated on
19 Nov 2026; since then no schema on production is `UNDATED`.

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
for a schema, because the live tables sit beside it.

🔴 **And the owner decides each table too (19 November 2026).** Until then a dated table went
`EXPIRED` on age alone — the one thing REC-040 forbids for a schema — so the first three to reach 90
days would have been printed for dropping with no decision behind them:
`au.zz_brick_backfill_snapshot_20260827` on 25 Nov, `au.bak_20260828_d3_line_area_map` and
`au.bak_20260828_d3_seats` on 26 Nov. Now `classifyTable()` and `classify()` share one ladder: a
table is decided in [`scripts/backup-schema-decisions.json`](../../scripts/backup-schema-decisions.json)
under `<schema>.<table>`, and past 90 days with no entry it is `UNDECIDED` with no drop statement.
`readDecisions()` refuses a dotted key outside `public` / `au`. Export, then drop works the same:
`node scripts/export-backup-schema.mjs au.<table>` writes `snapshot-exports/au.<table>/` with its own
`manifest.json`, and no `drop table` is printed until it exists. The owner answered the first three
in chat that day, each "export, then drop"; all three were exported the same day (166, 5 and 1
rows). The 29 Aug Delta (3) pre-image he keeps, `delta3_defer_backup_20260829`, is untouched: the two
28 Aug copies are not exact duplicates of it.

**The four 9 September tables, decided the same day.** He answered these in chat too, each "export,
then drop", and all four were exported that day. They reach 90 days on 8 Dec 2026:

| Table | Rows | What it holds |
| --- | --- | --- |
| `au.zz_rollup_pre_20260909_all` | 6,980 | the sales roll-up for January to August 2026 (plus six early-September rows) as it stood on 9 Sep; July and August are published and January to June were re-valued on purpose since |
| `au.zz_aug_rollup_pre_20260909` | 876 | an exact duplicate of the August rows inside the first (0 differences either way) |
| `au.bak_20260909_pedia_ue_split_line_area_map` | 50 | Pedia's area map before the Upper Egypt split; 11 rows were edited in place since, so the export is the lasting record of them |
| `au.bak_20260909_pedia_ue_split_seats` | 45 | Pedia's seats before the split; 10 were re-pointed that day, because a seat cannot carry a date |

**The two 12 September tables, decided the same day.** Both "export, then drop", both exported that
day. They reach 90 days on 11 Dec 2026:

| Table | Rows | What it holds |
| --- | --- | --- |
| `au.bak_20260912_pedia_kfs_d1_line_area_map` | 61 | Pedia's area map before Kafr El-Sheikh 1 moved from Alex-BHR to Delta (1) from 1 Sep; the move is dated, so August still reads the old shape, and 16 areas' staffed/vacant marks were edited in place since, so the export is the lasting record of them |
| `au.bak_20260912_pedia_kfs_d1_seats` | 49 | Pedia's seats before the move; only the Kafr El-Sheikh 1 rep seat changed since, and a seat cannot carry a date |

**The two 19 September tables, decided the same day.** Both "export, then drop", both exported that
day. They reach 90 days on 18 Dec 2026. Unlike the earlier ones, both were made with row-level
security off; neither browser role holds a grant on them or on the `au` schema, so neither was ever
reachable from the browser.

| Table | Rows | What it holds |
| --- | --- | --- |
| `au.bak_20260919_ismailia_suez_line_area_map` | 4 | Anti Infective Suez and Ismailia before the two became one area in Delta (3) from 1 Sep; the change was made in place on the open September row, so the export is the lasting record of Ismailia as a rep-less area, and the migration's own undo |
| `au.bak_20260919_ismailia_suez_seats` | 1 | the Suez rep seat before the change; only its label differs since |

**The three 23 September tables, decided the same day.** All three "export, then drop", all three
exported that day. They reach 90 days on 22 Dec 2026. Like the 19 September pair, they were made with
row-level security off and no browser grant. The employee copy holds personal and salary fields, so
its export stays in the exports folder beside the repository and is never committed.

| Table | Rows | What it holds |
| --- | --- | --- |
| `au.bak_move_ai0002_b177_emp_20260923` | 2 | the employee records of the two reps moved from Anti Infective to Pedia from 1 Oct, as of 23 Sep; several fields changed since |
| `au.bak_move_ai0002_b177_occ_20260923` | 6 | the seat-holder history of their two seats in both lines; every row is still live, only dates differ |
| `au.bak_move_ai0002_b177_lam_20260923` | 4 | the two areas in both lines; all still live, only the 1 Oct end date differs |

**The four 2 October tables, decided the same day.** All four "export, then drop", all four exported
that day. They reach 90 days on 31 Dec 2026. Row-level security off and no browser grant, like the
two before. Two were taken by hand, with no migration naming them.

| Table | Rows | What it holds |
| --- | --- | --- |
| `au.bak_20261002_luxor_rep_seat_revert` | 1 | Pedia Luxor's area row while it shared the Qena 2 rep seat, before the 2 Oct separation; the live row no longer has the link, so the export is its lasting record and the migration's undo |
| `au.bak_20261002_ped_d16_occupancy` | 3 | the seat-holder history of the Pedia Kafr El-Sheikh 1 rep seat, taken by hand; all still live, dates and the current holder's region corrected since |
| `au.bak_20261002_ped_ue_split_occupancy` | 4 | the seat-holder history of three Pedia Upper Egypt rep seats, taken by hand; all still live, only dates corrected since |
| `au.monthly_targets_pedia_oct2026_backup_20261002` | 144 | Pedia's October targets as first uploaded on 1 Oct, which left the live table by 2 Oct with no row in the drop ledger; October was uploaded again and published, and none of these rows match it, so the export is the lasting record of the first upload |

**The three 3 October schemas, decided the same day.** These are schemas, not tables, but they were
the next to reach 90 days, so they were put to him in the same way. All three "export, then drop", all
three exported that day. They reach 90 days on 1 Jan 2027. No migration creates any of them; nothing
reads them; no browser role, and not even `service_role`, can use the three schemas; staging has none.

| Schema | Tables · rows | What it holds |
| --- | --- | --- |
| `crm_backup_20261003` | 1 · 19 | a test walk-through on one CNS rep seat (a plan, its items and events, two visits and an off-plan visit), taken before it was cleared on 3 Oct; all test data, none live. Moved here from `public` by `20261023023133` |
| `crm_parity_backup_20261003` | 1 · 139,051 | the old CRM's visit mirror on 2 Oct: visit id, date and rep id, 1 Jan to 1 Oct 2026. 138,474 still match the live mirror; the nightly sync deleted the other 577 (two resigned reps' visits) between 3 and 19 Oct, and the deletion log keeps only their ids and dates, so the export is the one record of whose visits they were |
| `phoenix_crm_backup_20261003` | 22 · 2,380 | Phoenix CRM test data cleared from the live app on 3 Oct (test customers, list events, visits, places, photo records, plans), none of it live now; plus the 11 pharmacy visits' names before that evening's name backfill, whose visits are still live under the corrected names |

No dated table is next: the next snapshot to reach 90 days with no decision is the schema
`qena_split_backup_20261004`, on 2 Jan 2027.

The emitted statement is
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
