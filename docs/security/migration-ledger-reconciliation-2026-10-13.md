# Reconciling the ten migrations production's ledger had never heard of — the second round

**2026-10-13, on the owner's instruction.** Five days after
[the 2026-10-08 reconciliation](migration-ledger-reconciliation-2026-10-08.md),
`scripts/check-migrations-applied.ts` was again reporting ten migration files merged to `main` that
production's `supabase_migrations.schema_migrations` held no row for — by version **or** by name —
all of them past the 48-hour grace window, the oldest 138 hours old. These are ten **different**
files, all merged after the 2026-10-08 sweep was written.

**The headline: all ten are applied. None needed applying, and nothing was written to production.**
Six were proved by digest, four structurally, and two functions inside them turned out to be
superseded — the case where re-applying the file would have reverted production.

## The question, and the only answer that counts

Unchanged from 2026-10-08, and restated here because it is the whole method. A missing ledger row
means one of three things, with opposite correct responses:

1. **Applied, bookkeeping lost.** The ledger gets no row at all when SQL goes through a direct
   Postgres connection (`scripts/apply-sql-file.mjs`, `psql`), and gets a row stamped with the
   *MCP's own clock* when it goes through `apply_migration`, so the filename's 14 digits appear
   nowhere. Correct response: an evidenced entry in `ACKNOWLEDGED_EXCEPTIONS`.
2. **Superseded.** A later migration replaced the same function and production carries the newer
   body. Correct response: the same entry, plus a loud warning — **re-applying would revert
   production.**
3. **Genuinely unapplied.** Correct response: apply it.

🔴 **Existence proves nothing for case 1 or 2**, because nearly everything here is created with
`create or replace function`, `create table if not exists` or `add constraint` — an *older*
generation of the same object satisfies a catalog-presence probe exactly as well as the current one.
What was used instead: `md5(pg_proc.prosrc)` on production against the md5 of the file's own
dollar-quoted body. prosrc is stored verbatim, so an identical digest proves the text in the repo is
the text running in production, and a *differing* digest is the signal to go looking for the later
migration that superseded it.

🔴 **A function appearing in one of these files is only evidence if the file is its LAST definer in
the directory.** Several of the ten define a function that a *later* migration redefines; digesting
those would read as drift when it is simply history. Every digest below was taken against a function
whose newest definition in `supabase/migrations/` is the file being judged — and the exceptions are
called out as superseded instead.

## The six proved by digest

Each row is `md5(prosrc)` on `ozucdzovmcqvepbozvqf` equal to the md5 of the file's own body, with
the character count that came back from `length(prosrc)`.

| File | Function(s) proved md5-equal | Digest · chars |
| --- | --- | --- |
| `20261006234611_phoenix_crm_visit_company_and_admin_edit` | `phoenix_crm_admin_edit_visit` | `8e9e08c70f373ab3b576a8275688494b` · 5,885 |
| `20261008023801_phoenix_crm_validation_refusal_reason` | `phoenix_crm_decide_validation_review` | `10db6f07b837ad35fd230c3e012332e3` · 6,817 |
| `20261008024500_phoenix_crm_place_brick_lookup_write` | `phoenix_crm_move_place` | `d67d626e02daab6fccf529c5458f3aaa` · 3,501 |
| `20261009200000_deductions_leave_balance_charges` | `phx_attendance_balance_reversal_shape` | `0b8868570ef654644a7712589b2480a8` · 954 |
| | `phx_deductions_return_leave_balance` | `19cf8fa9e9b24f1c0dcff7ee999e3a49` · 2,007 |
| `20261010180118_phoenix_crm_seating_session` | `phoenix_crm_save_plan` | `daa8205f6cf06d69724f008af2d83218` · 6,271 |
| | `phoenix_crm_save_visit` | `2b2d499b83b93b2edd3574748637eeb0` · 28,152 |
| `20261010210000_phoenix_crm_seat_places_in_venue` | `phoenix_crm_seat_places_in_venue` | `10811cdd02818e4bfd935a79ba397cc2` · 10,241 |
| | `phoenix_crm_set_venue_timetable` | `cea0bbe19f2d6a0d7de8b995408d5927` · 2,441 |
| | `phoenix_crm_settle_venue_timetable` | `412c565c0bab71b9371af07474e17931` · 5,717 |

`20261010210000` is the cleanest of the ten: all three of its functions are md5-equal and it is the
last definer of each, so nothing in it is superseded. Their non-function halves were checked too —
`phoenix_crm_visit_edits` with `phoenix_crm_visit_edits_visit_idx`,
`phoenix_crm_validation_reviews.refusal_reason`, `phoenix_crm_customers.reopened_at` with
`phoenix_crm_customers_reopened_waiting_idx`, `attendance_annual_balance_charges` with its candidate
and unique indexes, and `phoenix_crm_places.session` are all live.

## The four proved structurally

These four define no function that they are the last definer of, so there is nothing to digest. Each
was settled on one-time facts instead — facts that could not be true unless that exact file had run,
and that no other migration in the repository produces.

**`20261010030000_notification_role_policies_retire_mapping_guard_key`** — the
`sos_mapping_guard_alert` row is **gone** from `public.notification_role_policies`, exactly **24**
policy rows remain, and `notification_role_policies_notification_key_check` has been rebuilt without
that key while still carrying `accepted_offer_alert`. That rebuilt CHECK body is precisely the
24-key list this file writes; a constraint cannot arrive at that shape by accident.

**`20261010030100_retire_mapping_guard`** — a file of **drops**, so presence-of-absence is the
proof, and it is stronger than a presence check: **0** functions matching `sos_map_guard%` or
`sos_move_brick_sales_after_hold`, **0** triggers matching `sos_map_guard%`, and
`public.sos_map_guard_permits` absent. The Mapping Guard is retired, which is also a standing rule —
see `.claude/rules/sales-imports.md`, "never rebuild it".

**`20261010100000_employees_hr_key_expression_index`** — an index **swap**, where both halves are
checkable and neither happens by accident. `employees_hr_id_upper_trim_idx` exists on exactly this
file's expression, `CREATE INDEX employees_hr_id_upper_trim_idx ON public.employees USING btree
(upper(btrim(hr_id)))`, and `employees_hr_id_lower_trim_idx` is **gone**.

**`20261010190000_phoenix_crm_one_timetable_for_a_polyclinic`** — its only function is superseded
(below), so the two unique indexes it alone creates are the evidence, and both are live with this
file's exact definitions: `phoenix_crm_shared_places_timetable_uidx` on
`phoenix_crm_shared_places(schedule_photo_path)`, and `phoenix_crm_places_photo_uidx` on
`phoenix_crm_places(photo_path) WHERE shared_place_id IS NULL`.

## The two superseded functions — where re-applying would have reverted production

Both are **comment-only** differences at the point of the match, exactly the benign shape the
2026-10-08 page predicted would be the commonest one here. The normalisation is identical on both
sides: strip `--` comments, then collapse whitespace to single spaces — on production with two
`regexp_replace` passes over `prosrc`, in the repo with the same two rules over the file's
dollar-quoted body.

### `phoenix_crm_insert_place` — defined by three of the ten, and none of them is what runs

Production's **raw** body digests to `34290d58f16d7b48ac803e6b626c0277`, 4,819 characters, and
matches no file's raw body. Comment-stripped it is `aafb5dc683b440aa49d8a5fc99909dd4`, 4,400
characters — equal to
`20261010190001_phoenix_crm_insert_place_session_and_one_timetable.sql`, a file that is **not** in
the ten because its ledger row is present.

So the versions inside `20261008024500`, `20261010180118` and `20261010190000` are all superseded,
and the oldest of them is several generations behind: `20261008024500` carries the 3,284-character
brick-lookup generation, against the 4,819 characters production runs. That newest file's own name
carries the answer — `_session_and_one_timetable` is `20261010180118`'s change and
`20261010190000`'s change folded into one body. 🔴 **Re-applying any of the three would revert up to
four later migrations' work to this one function at once, and nothing would go red.**

### `phx_deductions_charge_leave_balance` — superseded by the vacation categories

Production's comment-stripped body is `a79f9646940b18e1f8b8c9edcf55d679`, 3,617 characters, equal to
`20261009210000_deductions_leave_balance_vacation_categories.sql` — again a file whose ledger row is
present. `20261009200000`'s version is the generation before it. 🔴 **Re-applying it would drop the
vacation categories back out of the charge path.**

## The exceptions mask nothing on staging — checked, not assumed

`ACKNOWLEDGED_EXCEPTIONS` is shared by both legs of the nightly and by the staging applier, so an
entry added for a production-only gap would also silence a genuine staging gap. It does not here:
**all ten are in staging's ledger by version *and* by name**, read live on `cifwmndunmlxjhyjugxa`
before the entries were written. Same staging-first, production-second asymmetry as the eleven files
of 2026-10-08 — staging got them through `migrate:staging`, which writes the ledger; the production
applies went through the path that does not.

## Addendum, the same night: an eleventh file

`20261010214440_phoenix_crm_offplan_visit_caps.sql` crossed the 48-hour grace window while the ten
above were being judged, so it appears in no table on this page. It is the out-of-plan visit cap —
the owner's 2026-10-10 ruling that a rep may visit at most 2 doctors a day and 8 a week out of
plan — and it is **applied**, with a wrinkle worth recording.

`public.phoenix_crm_offplan_visit_cap` is the only definition of that function in the whole
directory, so nothing can have superseded it. Its raw digest does not match: production is
`5e269d3fb5350197ff7a03cfb7d4c38f` at 1,345 characters against the file's
`2cbed7244b08de499fda3f0d33b13283` at 1,630. Comment-stripped, both sides are
`8a4b9a20da1abcb9199ff50f17cf14ec` at 1,205 characters — identical logic.

🔴 **And this one is the mirror image of the 2026-10-08 comment cases.** There the file had been
annotated *after* it was applied. Here the file has exactly one commit, `cc2eb9dfa` (#5747,
2026-10-10 22:11 Cairo), and was never edited again — while production's `prosrc` carries **zero**
`--` comments at all, asked directly with `regexp_matches(prosrc, '(--[^\n]*)', 'g')`. So the body
that ran was sent comment-free, down a path that writes no ledger row; no ledger row on production
mentions `offplan` in its `statements` either. **A raw-digest mismatch with a comment-stripped match
is therefore not evidence about which side is newer** — only that the two differ in comments.

Everything the file does besides the function is live and exact: `offplan_daily_cap` defaulting to
2 and `offplan_weekly_cap` to 8 on `phoenix_crm_settings`, both CHECKs as written (1..20 and
1..100), the BEFORE INSERT trigger `phoenix_crm_visits_offplan_cap` on `phoenix_crm_visits`, and the
settings row itself reading **2 / 8**.

## What this round adds to the method

The 2026-10-08 page ends with five steps for the next time this check goes red. They all held. Two
more earned their place here:

6. **Check that the file is the function's LAST definer before you digest it.** Three of these ten
   define `phoenix_crm_insert_place` and not one of them is what production runs. Digesting the
   file's own body against production would have reported three mismatches and sent a session
   hunting drift that does not exist — or worse, re-applying.
7. **A file of drops is easier to prove than a file of creates, not harder.** `sos_map_guard%`
   returning zero functions, zero triggers and no permits table cannot be produced by an older
   generation of anything; absence has no history.
8. **Digest a record's prose the same way you digest a function body, and read the whole clause.**
   The 2026-10-08 page's one open flag — Luxor's `au.line_area_map` notes "documenting the
   superseded 2026-09-11 arrangement" — was wrong, and is withdrawn on that page with the evidence.
   The notes are byte-identical to what that migration writes (`bf6f192ed0baf57e79ed6182cf9b0768`,
   387 characters) and say the union **was reverted**; the 2026-09-11 date is in them because a
   reversal names what it reverses. One `md5(notes)` would have settled it, and the alternative was
   a needless write to a live org record.
9. **Before reading a comment difference as "the file was annotated later", ask git.** The eleventh
   file above has one commit and has never been edited, and production is the side missing the
   comments. Stripped-equal says the logic is the same; it says nothing about which text came first.

## Later the same day: the eleven also got a ledger row, and both mechanisms stay

A second session, working from the **primary checkout 18 commits behind `origin/main`**, ran the
same drift check against the same production project and was told **11 migrations merged to main
but not found**. The same command from a tree at `origin/main` printed *"OK — every migration
outside the grace window is accounted for"* an hour earlier. The eleven it named are exactly the
eleven reconciled above: `selectMissingMigrations` filters `ACKNOWLEDGED_EXCEPTIONS` **first**, and
the commit that added them was not in the lagging tree. Ruled out by measurement before the cause
was found — the 48h grace window (each file's commit time is identical from both trees, 0 of 11
sheltered either way), a changed ledger (`xmin` ordering shows the newest row not inserted by that
session predates its own writes, so nothing was deleted in the window), and the wrong project
(staging's ledger is a different size, and the run printed production's ref).

Before that cause was found, that session recorded the eleven versions in
`supabase_migrations.schema_migrations` on production — ledger **1,313 → 1,324 rows** — and then
asked the owner whether to roll them back now that the exceptions turned out to be the answer.

> **Owner, 2026-10-13: keep the 11 ledger rows and leave the exceptions in place.**

So both mechanisms now cover the same eleven files, deliberately:

- The **ledger rows** make the drift check quiet from *any* checkout, current or lagging, and they
  are the honest record — every one of those migrations really has been executed on production.
- The **exception entries** stay because they carry the evidence. A row in
  `schema_migrations` is a bare `(version, name)` pair that says nothing about *how* it was proved;
  the entries, with the two pages behind them, are where the `md5(prosrc)` digests, the
  last-definer checks and the two superseded functions are written down.

Neither is removed to tidy the other. 🔴 **And a missing ledger row is still not answered by a
ledger write** — the order above is the method: digest, last-definer check, evidenced exception
entry. The write happened here because the check was read from a stale tree, which is the one
mistake this round adds to the list.

10. **Run the drift check from a tree on `origin/main`, and treat its output from a lagging
    checkout as a question rather than a finding.** `git fetch` and compare before believing it.
    Pinned, for the exception list's own rot, by `tests/migration-exception-staleness.test.ts`.
