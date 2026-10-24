# The CRM contact-master refresh: three seconds of work that could not change anything

Measured 16 October 2026 in the slowness audit, fixed the same night by migration
`20261016233000_crm_contact_master_refresh_skips_idle_work.sql`. The rule is in
`.claude/rules/crm-doctor-lists.md`; the pin is `tests/crm-contact-master-refresh-speed.test.ts`.

## What was slow

`public.crm_contact_master_refresh(boolean)` runs after every contact-list sync slice (every five
minutes from 06:00 to 22:00 Cairo, plus the daily cron). In the audit's `pg_stat_statements` window it
averaged **2,951 ms over 517 calls, peaked at 7,896 ms** against PostgREST's 8 s cut, and spent
**1,526 s of database time**.

## Where the time went

Timed statement by statement on production inside transactions that were rolled back, with
`EXPLAIN (ANALYZE)`:

| Statement | Time | Why |
| --- | --- | --- |
| The frozen-reps count | 1,235 ms | A nested loop of 12,142 open assignments by ~56 started reps — 675,218 filter checks, each `lower(btrim())`-ing the same text |
| The region-from-name update | 450–1,300 ms | Read all 142,560 visits (209 MB) and sorted 104,240 of them to hand a region id to contacts that carry a region NAME and no id. On production that is **0 contacts** |
| The contacts upsert | 250 ms | `ON CONFLICT DO UPDATE … WHERE` locks every conflicting row (11,139) before the filter runs: 11,900 WAL records and 656 full-page images (1.7 MB) to change 112 rows |
| The name-row upsert | 148 ms | Same shape: 12,454 locks, 0 rows changed |
| Everything else together | ~600 ms | Untouched |

The audit rows agree: list 1.1–1.5 s, regions 0.45–1.3 s, assignments 0.9–1.2 s per run. The daily
activity pass (2.9 s, once a day) is not touched.

## The change

Four statements change; everything else in the body is byte-identical to
`20261015215500_a_vendorless_reps_phoenix_list_opens.sql`, the file whose body production held.

1. **The started reps are read once into two arrays** (`v_started_keys text[]`,
   `v_started_crm_ids bigint[]`), NULLs filtered out. The five places that asked "does this row belong
   to a rep whose team has started?" by joining the 88-row temp table with an `OR` of two conditions —
   which no join method can hash — now write the same two conditions as `= any (array)`. The test is
   exact: the two conditions do not depend on the started rep, and neither side can be NULL, so
   `not (…)` is the old `not exists`.
2. **The region-from-name update sits behind an `exists` test** for a contact with a region name and no
   id, and when it does run it reads only the visits of the names those contacts carry. The counter
   stays at its declared 0 when the branch is skipped, which is what an update of zero rows reported.
3. + 4. **The two `ON CONFLICT` upserts into `crm_contacts` are fed only rows that would change**: the
   source rows are left-joined to the table first, and only a new row or one that differs by the SAME
   predicate the conflict filter uses reaches the upsert. The `on conflict … do update … where` clauses
   are untouched, so a row that changes between the join and the lock is still judged by the original
   filter. The only difference: a row the statement snapshot already shows as current is no longer
   locked, so a concurrent writer that changes one in those milliseconds is corrected by the next run,
   five minutes later.

`SECURITY INVOKER`, `search_path = public`, the advisory lock, the grants (`service_role` alone) and the
function comment are unchanged.

## Proof the answer did not change

Every comparison ran the LIVE function and then the new one in the same rolled-back transaction over the
same data, comparing the returned counts (every field except `ms`), a checksum of every column of
`crm_contacts` and `crm_contact_assignments` (ids and timestamps excluded), and the set of rows whose
`updated_at` moved.

| Where | Scenario | Result |
| --- | --- | --- |
| Staging | Heavy perturbation: 300 renamed mirror rows, 200 regraded, 150 deleted, 80 new, 400 contacts stripped of their region id, 300 assignments deleted, 60 fake open vendor rows in every "is a started rep" shape, 100 customers dropped, 150 Phoenix periods deleted | IDENTICAL (assignmentsFrozen 3,694, closed 348, opened 525, discarded 10, touched 149, regionsFromName 178, Phoenix opened 131 / closed 28) |
| Staging | The same with every team start deleted, so both arrays are empty | IDENTICAL |
| Staging | Nothing perturbed — the steady state the job meets every five minutes | IDENTICAL |
| Production | Unperturbed, hourly-style (no activity pass) | **3,055 ms → 1,139 ms**, identical counts, identical checksums (contacts `d4c9c487cd207cc56d199f1ffc83b9f9`, assignments `c502703a849506b236a580cb25904b22`), the same 112 rows moved |

After the apply, the live function on production, rolled back: **1,161 ms** without the activity pass
and 3,587 ms with it. With activity off the steps took: list 314, bricks 42, regions 7 (the guard skips
it), assignments 726 ms. On staging the regions step still runs, because 86 contacts there carry a name
and no id.

The apply landed outside the poller window (about 22:40 Cairo) through
`PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs <file> <env>`,
the standing route; it writes no ledger row, so the migration ends in an evidenced entry in
`ACKNOWLEDGED_EXCEPTIONS` (`scripts/lib/migration-inventory.ts`). `md5(prosrc)` reads
`8f343dc21428862adb1d4df1a66190b8` (31,040 characters) on both projects.

**Rollback:** re-apply `20261015215500_a_vendorless_reps_phoenix_list_opens.sql`; it re-emits the
previous body (`f099c54bdeed10ee8b8756968a972c73`).

## Why the pin is a shape test

Every one of these failures is silent. Put the per-row join back, drop the region guard, or feed the
upserts every row again, and every returned number and every row stays right while the job goes back to
three seconds. The test therefore pins the SHAPE — the arrays, the five `= any` tests, the guard, the two
pre-filters and the untouched conflict clauses — and the header's stated `md5(prosrc)` against the body
below it, which is how an apply is proved (`create or replace` makes the mere presence of the function
worthless as evidence).

## Not changed, and not hidden by this

112 doctors whose mirror row has no phone are blanked by the first upsert and refilled from their
Phoenix customer by the second **on every run** — 224 writes a run that end where they started. Both
versions do exactly that; it is the cause of the "112 rows moved" in every comparison above, and is the
next cost in this function if it needs to go lower.

## First scheduled runs

The first production runs on the new body are the 06:00 Cairo poller slices on 17 October; their
`pg_stat_statements` rows and the refresh's own audit rows are the live proof. The statement baseline
taken at 20:44 Cairo on 16 October is the comparison point (the scheduled read-only comparison at 09:00
on 17 October reports against it); cumulative statistics still carry the pre-fix calls, so read the
delta, not the mean.

## The 24 October pass: four shapes the planner could not rescue

The owner's words, 2026-10-24: *"fix the crm contact master refresh"*. The 16 October pass above had
already taken the call from 2,951 ms to under two seconds; this one takes it to **794 ms**, and every
one of its four causes is a shape, not a missing index.
`supabase/migrations/20261024160000_the_contact_refresh_hashes_its_handover_and_reads_the_rep_door_once.sql`.

**1 · An `OR` of two equalities is not an equijoin.** The vendor handover matched a rep either by hr key
or by CRM id — `(hr id present and l.hr_key = …) or (hr id blank and l.agent_crm_id = …)`. No join method
can hash that, so it ran as a Nested Loop over the 2,138 open vendor rows by the 73 list rows and threw
**156,074** of them away in the join filter: **316 ms a run**, the single most expensive statement in the
function, to hand over **0 rows** on a quiet tick. The two arms are mutually exclusive by construction —
the first needs an hr id, the second needs it blank — so the lookup now emits **both** keys per rep (the
hr key, and `crm:<id>`) and the join compares one expression,
`l.match_key = coalesce(nullif(lower(btrim(a.agent_hr_id)), ''), 'crm:' || a.agent_crm_id::text)`. Proved
on production to select the same **21,481** rows, 0 either way. `crm:` cannot collide with an hr key: hr
ids are the `b-10` shape and carry no colon — a prefix is only safe where the other key's alphabet
excludes it.

**2 · The rep door was read twice.** `public.phoenix_crm_doctor_list_reps()` is a 48 ms Function Scan
(1,053 buffers for 93 rows) and the body called it once for the four vendor passes and again 450 lines
later for the fifth pass's list. One `pg_temp` snapshot now serves both, which is also strictly more
consistent: the started set the vendor passes skip is the same set, to the row, as the one the fifth pass
writes.

**3 · `analyze pg_temp.<table>` names its columns, or it builds histograms nothing reads.** Timed on
production on tables built fresh so no page was warm: `crm_refresh_phoenix_customers` all 14 columns
**168 ms** against the 7 its three readers join, filter or sort by **53 ms**; `crm_refresh_phoenix_truth`
all 5 **80 ms** against `contact_crm_id` alone **3 ms**. The rest are projected into the two upserts and
never compared — 192 ms a run, about 96 runs a day, read never.

**4 · A SQL function with a `SET` clause cannot be inlined.** `public.crm_contact_fold_grade` carries
`set search_path to 'public'`, so each of its five call sites was a real function call per row — about
**110 ms** of the list build alone. The expression is inlined at all five, character for character from
the function's own body (`20260913150000`). The function is **not** changed and **not** dropped: its other
callers keep it, and taking its `SET` clause off to win the inlining would raise a
`function_search_path_mutable` advisor finding that `scripts/check-advisor-baseline.ts` fails `validate`
on. That trade — inline the expression, leave the helper alone — is the rule the module memory carries.

### Measured

On production `ozucdzovmcqvepbozvqf`, inside one rolled-back transaction with the pending row settled
first so every timed run is the quiet tick the cron actually pays, old and new alternating four times
each:

| | 1 | 2 | 3 | 4 | median |
| --- | --- | --- | --- | --- | --- |
| old body | 1,320 ms | 1,300 ms | 1,357 ms | 1,435 ms | **1,338 ms** |
| new body | 770 ms | 769 ms | 831 ms | 818 ms | **794 ms** |

41% off the whole call, about 545 ms a tick, roughly **52 seconds of database time a day** at ~96 ticks.
Live committed runs after the apply: **1,052 · 814 · 783 · 1,065 ms** (`contactsTotal 22242`,
`assignmentsFrozen 10204`, every other counter 0).

### Proof the answer did not change

From the same committed production state, each body run once in its own rolled-back transaction, twice
each. Both wrote exactly one assignment row and the same one — agent PD-0018, contact 1000049049,
Pharmacy, no grade, source `phoenix_crm`, open from 2026-10-24 — and the full-row checksum of
`crm_contacts` was `e3044c1025dc165bef1258ad931c4af4` on all four runs. The returned jsonb was equal field
for field, the per-statement `ms` map aside. The assignments checksum differs between runs only by the
serial `id` the rolled-back sequence had already advanced, which is why the row-level diff, not the
checksum, is the proof for that table.

Applied to staging `cifwmndunmlxjhyjugxa` and production `ozucdzovmcqvepbozvqf` through
`scripts/apply-sql-file.mjs` (the standing route when the MCP refuses a body containing `delete` /
`drop table pg_temp.…` — AGENTS.md §8), which writes no ledger row: the apply is proved by the digest the
header states, `md5(prosrc) = a6dc9541576a7a474ad6a49c60013f34`, 36,805 chars, on **both** databases,
with `prosecdef false` and `proconfig search_path=public` unchanged.

Every one of the ten new assertions in `tests/crm-contact-master-refresh-speed.test.ts` section `3c` was
proved by reverting the fix it pins and watching its own headline message fire — eight realistic reverts,
plus five runs with the first-throwing assert neutralised to reach the four it shadowed.
