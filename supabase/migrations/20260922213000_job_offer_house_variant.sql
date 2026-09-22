-- A FOURTH built-in offer design: the HR-forms house-identity letter (SATO-DIS-2026-01).
--
-- Same shape as 20260922210000 (the Sato variant): the design itself lives in code
-- (src/lib/offers/house-template.ts) and is seeded into `offer_templates` on demand by
-- ensureBuiltinTemplates(), which inserts any built-in key not already present. The one thing code
-- cannot do is widen the CHECK constraints that gate `variant` and `builtin_key`, so a seed insert
-- of 'house' is REFUSED until this migration runs. It must therefore be APPLIED BEFORE the code that
-- seeds the row deploys.
--
-- Both constraints are dropped and re-added with 'house' added to the set they already allow
-- ('classic', 'executive', 'sato'). Every new set is a superset of the current one, so every existing
-- row still satisfies it and the swap validates instantly. No data is rewritten, and the three
-- existing designs are untouched.

begin;

alter table public.offer_templates
  drop constraint if exists offer_templates_variant_known;
alter table public.offer_templates
  add constraint offer_templates_variant_known
  check (variant in ('classic', 'executive', 'sato', 'house'));

alter table public.offer_templates
  drop constraint if exists offer_templates_builtin_key_known;
alter table public.offer_templates
  add constraint offer_templates_builtin_key_known
  check (builtin_key is null or builtin_key in ('classic', 'executive', 'sato', 'house'));

comment on column public.offer_templates.builtin_key is
  'Which shipped design this row is a copy of (classic | executive | sato | house), or null for a template built in the designer. Restore matches on this, never on name.';
comment on column public.offer_templates.variant is
  'The CSS skin the blocks are drawn in (classic | executive | sato | house). All built-ins share one block list and one renderer; this chooses the visual identity.';

commit;
