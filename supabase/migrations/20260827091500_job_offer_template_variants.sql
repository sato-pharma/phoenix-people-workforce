-- A second built-in offer design, and the two columns that make a library of designs possible.
--
-- WHY THIS IS A SEPARATE MIGRATION rather than an edit to 20260826234500_job_offer_module.sql.
-- That file has already been applied to the staging project (cifwmndunmlxjhyjugxa), so editing it
-- would leave staging on a schema no migration in this repository describes, and the ledger would
-- report a version that no longer matches what ran. Production has none of the three tables yet
-- and will get both files in order.
--
-- WHAT CHANGES. `offer_templates` gains:
--
--   builtin_key — which SHIPPED design a row is a copy of, or null for one somebody built in the
--                 designer. This is the anchor for Restore: the built-ins are regenerated from
--                 code (src/lib/offers/builtin-templates.ts), and the row is matched by this key
--                 rather than by name — so renaming "SATO Executive Offer" in the UI cannot orphan
--                 it and cause a duplicate to be seeded beside it on the next request.
--
--   variant     — the SKIN the same blocks are drawn in. Both built-ins render the identical block
--                 list; the variant appends a CSS override sheet. That is why either design can be
--                 edited into anything and still look like itself, and why one editor, one preview
--                 and one PDF path serve both.

begin;

alter table public.offer_templates
  add column if not exists builtin_key text,
  add column if not exists variant text not null default 'classic';

-- Constrained rather than free text. A typo here does not throw — it renders the wrong design onto
-- a legal document that then goes to a candidate, which is the kind of wrong that gets signed.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'offer_templates_variant_known'
  ) then
    alter table public.offer_templates
      add constraint offer_templates_variant_known check (variant in ('classic', 'executive'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'offer_templates_builtin_key_known'
  ) then
    alter table public.offer_templates
      add constraint offer_templates_builtin_key_known
      check (builtin_key is null or builtin_key in ('classic', 'executive'));
  end if;
end $$;

-- One row per shipped design, at most. Without this, a seeder racing itself across two requests
-- would leave two "SATO Executive Offer" rows and Restore would fix one of them.
create unique index if not exists offer_templates_builtin_key_idx
  on public.offer_templates (builtin_key)
  where builtin_key is not null;

-- ADOPTION. Staging already holds a seeded default row from the first migration, written before
-- `builtin_key` existed. It IS the classic design, so it is claimed rather than left orphaned —
-- otherwise the seeder would insert a second copy of the same letter next to it and the owner
-- would open the designer to two identical templates.
--
-- Guarded on there being no classic row yet, so re-running this migration cannot claim a row the
-- owner has since made his own.
update public.offer_templates
   set builtin_key = 'classic'
 where is_default
   and builtin_key is null
   and not exists (
     select 1 from public.offer_templates t where t.builtin_key = 'classic'
   );

comment on column public.offer_templates.builtin_key is
  'Which shipped design this row is a copy of (classic | executive), or null for a template built in the designer. Restore matches on this, never on name.';
comment on column public.offer_templates.variant is
  'The CSS skin the blocks are drawn in (classic | executive). Both built-ins share one block list and one renderer; this chooses the visual identity.';

commit;
