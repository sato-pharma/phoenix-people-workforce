# Reconciling the ten migrations production's ledger had never heard of

**2026-10-08, on the owner's instruction.** `scripts/check-migrations-applied.ts` had been reporting
ten migration files merged to `main` that production's `supabase_migrations.schema_migrations` held
no row for — by version **or** by name — all of them well past the 48-hour grace window. This is the
account of what each one turned out to be, and why nine were excused and one was applied.

## The question, and the only answer that counts

A missing ledger row means one of three things, and they have opposite correct responses:

1. **Applied, bookkeeping lost.** Production's ledger gets no row when the SQL goes through a direct
   Postgres connection (`scripts/apply-sql-file.mjs`, `psql`) — that path writes no
   `schema_migrations` row at all — and gets a row stamped with the *MCP's own clock* when it goes
   through `apply_migration`, so the filename's 14 digits appear nowhere. Correct response: an
   evidenced entry in `ACKNOWLEDGED_EXCEPTIONS`.
2. **Superseded.** A later migration replaced the same function, and production carries the newer
   body. Correct response: the same entry, plus a loud warning — **re-applying would revert
   production.**
3. **Genuinely unapplied.** Correct response: apply it.

🔴 **Existence proves nothing for case 1 or 2.** Almost every object here is created with
`create or replace function`, `create table if not exists` or `add constraint`, so an *older*
generation of the same object satisfies a catalog-presence probe exactly as well as the current one.
Asking `to_regclass` and `pg_proc` whether the name exists answers yes for all ten and is worthless.

**What was used instead:** `md5(pg_proc.prosrc)` on production, compared against the md5 of the
file's own dollar-quoted body. prosrc is stored verbatim, so an identical digest is proof the exact
text in the repo is the text running in production — and a *differing* digest is the signal to go
looking for the later migration that superseded it.

🔴 **One trap inside that method.** `length(prosrc)` and the file body's JavaScript `.length` can
differ by a few characters while the md5 is identical, because JS counts UTF-16 units and Postgres
counts characters — every emoji in a comment costs one extra. `phoenix_crm_load_list_customers` read
9,573 against 9,569 with the digests equal. **Trust the digest; a length gap alone is not drift.**

## The nine that were already live

| File | Proof |
| --- | --- |
| `20261002123958_phoenix_crm_visits_everywhere` | `phoenix_crm_team_starts` (10 cols) + its one-running unique index; `phoenix_crm_set_team_start`, `_started_team_seats`, `_started_team_reps` all md5-equal |
| `20261002135638_phoenix_crm_visit_asks` | `phoenix_crm_visit_asks` (19 cols, 6 indexes, the service_role policy); `raise_`/`answer_`/`cancel_visit_ask` all md5-equal |
| `20261002142118_phoenix_crm_plans_everywhere` | `phoenix_crm_plan_day_status` md5-equal; both views present, and `crm_plan_entries_unified`'s definition calls it |
| `20261002142625_..._saved_event_keeps_the_returned_day` | `phoenix_crm_save_plan` md5-equal |
| `20261002150353_phoenix_crm_pharmacy_reference` | **superseded** — see below |
| `20261002205435_phoenix_crm_pharmacy_list_type` | both widened CHECKs carry `Pharmacy`; `phoenix_crm_plan_items_list_type` deliberately does not |
| `20261002205436_phoenix_crm_visit_product_manager` | `product_manager_hr_id` present; all three rewritten CHECKs name it; the function **superseded** — see below |
| `20261004141055_drop_line_month_targets_with_archive` | `au.monthly_targets_dropped` (14 cols) + period index; `phx_drop_monthly_targets` md5-equal |
| `20261006002000_phoenix_crm_customer_name_fold` | `phoenix_crm_fold_name` and `phoenix_crm_load_list_customers` md5-equal |

**The asymmetry in `20261002205435` is the rule, not an oversight.** `phoenix_crm_customers` and
`phoenix_crm_visits` accept `Pharmacy`; `phoenix_crm_plan_items` does not, because a pharmacy is
never planned. A later "tidy-up" that widens the third CHECK for consistency would break the owner's
own rule — the file's own comment says so, and production matches it.

### The two superseded ones, and why re-applying them would be a regression

**`phoenix_crm_seat_reference`** looked like the one real mismatch: production's digest matched none
of the four repo definitions, and production's body sat between two of them in length. The ledger
settled it — one row touches that function, `20261002205554 / phoenix_crm_seat_reference_and_place_removal`,
with its `statements` populated, i.e. an `apply_migration` stamped **before** the filename
`20261002224250` it corresponds to. The file kept being annotated after it was applied. Stripping
`--` comments and whitespace from both sides makes them identical:
`6b12054c9d9b1cf0e323b0e442d7dabe`, 2,830 characters each. **The entire 669-byte gap is comment
text.** `20261002150353`'s own change is live inside that newer body —
`list_type in ('AM', 'PM', 'Pharmacy')`.

**`phoenix_crm_save_visit`** was replaced four more times after `20261002205436`, most recently by
`20261006234611_phoenix_crm_visit_company_and_admin_edit.sql`, whose body md5 —
`3e9032ede88b89857d22ffb61ddac52c` — is exactly what production runs.

Re-running either file would `create or replace` an older body over a newer one, with nothing going
red. That is why both carry a warning in the exceptions list rather than a bare filename.

### The exceptions mask nothing on staging — checked, not assumed

`ACKNOWLEDGED_EXCEPTIONS` is shared by both legs of the nightly and by the staging applier, so an
entry added for a production-only gap would also silence a genuine staging gap. It does not here:
**all ten are in staging's ledger by version *and* by name**, read live on
`cifwmndunmlxjhyjugxa` before the entries were written.

That is the whole shape of this incident in one line. Staging got them through
`migrate:staging`, which writes the ledger; the production applies went through the path that does
not. The documented workflow is staging-first, so applied-on-staging / missing-on-production is the
*normal* failure direction — which is exactly why `check-migrations-applied.ts` was moved off its
staging-only proxy, and why that move is what surfaced these at all.

## The one that was real: Luxor

`20261002184148_luxor_separate_from_qena2_no_rep_seat.sql` reverts the 2026-09-11 shared-rep-seat
union, so Luxor carries no rep seat of its own. It has two statements inside one transaction: an
idempotent pre-image `create table if not exists`, then an `update` guarded on the drifted value.

Production looked applied — `au.bak_20261002_luxor_rep_seat_revert` existed with one row, and
`au.line_area_map` for `pedia`/`OT6` already read `rep_seat_id = NULL`, the file's target state. It
was not:

- The pre-image row holds the **drifted** value, `SEAT-PED-REP-UE8`.
- The live row has the **same** `effective_from` (2026-09-01), the **same** `notes` digest as that
  pre-image, and `rep_seat_id = NULL`.

That combination cannot come from this migration. Its `update` sets `rep_seat_id` **and** `notes` in
one statement, so a run that nulled the seat would have rewritten the notes too. The notes still
describe the 2026-09-11 decision the file exists to reverse. Nothing in the repo writes that text, and
no ledger row anywhere on production — searched by name and by `statements` content — mentions the
pre-image table or the file's new notes. So the pre-image half ran and the seat was nulled by
something else that never touched `notes`.

**Applied 2026-10-08**, ledger `20261008115526`. Verified after: `rep_seat_id` still `NULL`, notes
digest **unchanged**, pre-image untouched at one row holding `SEAT-PED-REP-UE8`. The guarded `update`
matched zero rows — exactly what the guard is for, and what the file's own header promises on a
database already at the golden-rule state.

🔴 **What this leaves, and it is the owner's call, not a session's.** The business state is correct:
Luxor has no rep seat, so nobody is credited for its sales through a shared seat. But
`au.line_area_map`'s `notes` for that row still *document* the superseded 2026-09-11 arrangement, and
no migration will ever correct it — the only statement that would have is permanently guarded off.
Anyone reading that row to understand the territory reads the wrong decision. Correcting it is a
one-row documentation write to a live org record, which is why it is flagged here instead of done.

## Addendum, the same evening: an eleventh file

`20261006185533_crm_contact_list_refusal_neutral.sql` was flagged after the ten above had been
settled, so it appears in no table on this page. The run that surfaced it read **815 local
migrations against 1,267 recorded** on `ozucdzovmcqvepbozvqf` and named this one file, 52 hours old.

It is case 2, and the clearest example of it on this page:

| `public.crm_contact_list_change_apply` | `20261006185533` (this file) | `20261007200000` (the later one) | Production **and** staging |
| --- | --- | --- | --- |
| body length | 6,498 chars | 9,516 chars | 9,516 chars |
| raw md5 | `50644d369fc29cfd0134683670861fc3` | `b5a5a2ab9ec3a9ef14f6bff322c0f445` | `b5a5a2ab9ec3a9ef14f6bff322c0f445` |

Re-applying it would `create or replace` a 6,498-character body over the 9,516-character one that is
running, taking the later migration's own changes to that function with it, and nothing would go red.

**It is superseded, not reverted**, and that was established separately from the digest: all seven
neutral refusal strings this file introduces are live in production's `prosrc`, matched one at a time
with `position(<msg> in prosrc)` — `That change was not found.`, `This change has already been
decided or withdrawn.`, the iReports360 team-has-not-started refusal, `Only the manager this change
was sent to can approve it.`, `That doctor is already on this list.`, `That doctor is not on this
list any more.` and `That doctor already has this grade.` Seven of seven returned true.

Production's ledger holds no row for it under any name; staging's holds it by version **and** name
(`20261006185533 / crm_contact_list_refusal_neutral`). So the entry masks nothing on staging, and the
asymmetry is the same staging-first, production-second shape as the other ten.

## What to do when this check goes red again

1. **Do not re-apply on the strength of a catalog probe.** Digest the function bodies.
2. **Ask the ledger what it DID apply** — `name ilike`, and
   `exists (select 1 from unnest(statements) s where s ilike '%<object>%')`. A row whose `statements`
   are populated came through `apply_migration` and carries the SQL that actually ran.
3. **When a digest does not match, look for the later migration** before concluding anything is
   missing. `git grep -l 'function public.<name>'` over `supabase/migrations/`, newest last.
4. **Strip comments before calling it drift.** A file annotated after it was applied is the commonest
   benign difference here, and it was nearly reported as a defect.
5. **Add the entry with its evidence, not just the filename.** The sixty entries above this block are
   the only reason this check is still readable.
