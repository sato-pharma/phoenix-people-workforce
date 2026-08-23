-- A marketing venue had no way to say what it became.
--
-- `direct_order_pharmacies` has carried a merge trail since 20260809031500 — the four duplicate
-- "حضانة زمزم" rows were folded into one on 2026-08-13 and each loser still points at the survivor.
-- `marketing_pharmacies` had no equivalent, so the only way to express a marketing merge was to
-- deactivate the duplicate and write a sentence into `validation_notes`. Prose is not navigable: a
-- pharmacy_code quoted in an older report or email resolves to a dead row with nothing saying where
-- the live one is, and the pair invites the same investigation every time somebody sees two rows
-- with one name. That happened on 2026-08-23 with "صيدليه حضانه النيل".
--
-- Deliberately identical in shape to the Direct Orders columns rather than a parallel invention, so
-- one mental model covers both modules.

alter table public.marketing_pharmacies
  add column if not exists merged_into_pharmacy_id uuid,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_by_hr_id text;

-- ON DELETE SET NULL, not CASCADE: deleting a survivor must never delete the record of the
-- duplicates that were folded into it. The pointer goes, the row stays.
alter table public.marketing_pharmacies
  drop constraint if exists marketing_pharmacies_merged_into_fkey;

alter table public.marketing_pharmacies
  add constraint marketing_pharmacies_merged_into_fkey
  foreign key (merged_into_pharmacy_id) references public.marketing_pharmacies(id) on delete set null;

-- A row cannot be merged into itself. Without this a single mistyped id makes a venue its own
-- survivor, which reads as "merged" everywhere while pointing at nothing that exists elsewhere.
alter table public.marketing_pharmacies
  drop constraint if exists marketing_pharmacies_merged_not_self_check;

alter table public.marketing_pharmacies
  add constraint marketing_pharmacies_merged_not_self_check
  check (merged_into_pharmacy_id is null or merged_into_pharmacy_id <> id);

-- Partial: almost every venue is not a duplicate, so the index only carries the ones that are.
create index if not exists marketing_pharmacies_merged_into_idx
  on public.marketing_pharmacies (merged_into_pharmacy_id)
  where merged_into_pharmacy_id is not null;

comment on column public.marketing_pharmacies.merged_into_pharmacy_id is
  'The surviving venue this duplicate was folded into. Its customer links, request targets and '
  'distributor codes were moved there and this row deactivated. NULL for every venue that is not a '
  'duplicate, which is nearly all of them. Identity is proven by captured GPS and address, never by '
  'a similar name — venue names are typed by hand in two languages and prove nothing on their own.';

comment on column public.marketing_pharmacies.merged_at is
  'When the merge was performed. NULL unless merged_into_pharmacy_id is set.';

comment on column public.marketing_pharmacies.merged_by_hr_id is
  'Who performed the merge. NULL for rows backfilled from a duplicate the system had already '
  'deactivated, because no person made that call through the application.';

-- ── Backfill the one merge that already happened ────────────────────────────────────────────────
--
-- "صيدليه حضانه النيل" was captured twice by B-154 on 2026-08-22, eight minutes apart: the first
-- attempt saved with no evidence photo, the rep recaptured, and the whole first capture (customer,
-- venue, distributor code and link) was left inactive. Nothing recorded where it went. Guarded on
-- the survivor existing so this is a no-op on any database that does not hold these rows, and on
-- merged_into_pharmacy_id being null so re-running never overwrites a real later merge.
update public.marketing_pharmacies
   set merged_into_pharmacy_id = 'dfe8d718-2207-4556-871d-a4f8e999a143',
       merged_at = timestamptz '2026-08-23 07:20:00+00'
 where id = '11d655a9-68b2-4b1e-ba39-18c1fde94b2d'
   and merged_into_pharmacy_id is null
   and exists (
     select 1 from public.marketing_pharmacies survivor
      where survivor.id = 'dfe8d718-2207-4556-871d-a4f8e999a143'
   );
