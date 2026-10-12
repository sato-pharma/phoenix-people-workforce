-- A FIFTH built-in offer design: the HR premium identity letter ("SATO Premium Offer").
--
-- Same shape as 20260922213000 (the house variant): the design itself lives in code
-- (src/lib/offers/premium-template.ts) and is seeded into `offer_templates` on demand by
-- ensureBuiltinTemplates(), which inserts any built-in key not already present. The one thing code
-- cannot do is widen the CHECK constraints that gate `variant` and `builtin_key`, so a seed insert
-- of 'premium' is REFUSED until this migration runs.
--
-- ORDER MATTERS: apply this to STAGING and to PRODUCTION BEFORE the code that registers the design
-- deploys. Railway applies no migrations, and ensureBuiltinTemplates() THROWS when the insert is
-- refused, so a deploy that lands first breaks the offer designer's template list until this runs.
--
-- Both constraints are dropped and re-added with 'premium' added to the set they already allow
-- ('classic', 'executive', 'sato', 'house'). Every new set is a superset of the current one, so every
-- existing row still satisfies it and the swap validates instantly. No data is rewritten, and the
-- four existing designs are untouched. Re-running it is harmless: each constraint is dropped if it
-- exists before it is added.

begin;

alter table public.offer_templates
  drop constraint if exists offer_templates_variant_known;
alter table public.offer_templates
  add constraint offer_templates_variant_known
  check (variant in ('classic', 'executive', 'sato', 'house', 'premium'));

alter table public.offer_templates
  drop constraint if exists offer_templates_builtin_key_known;
alter table public.offer_templates
  add constraint offer_templates_builtin_key_known
  check (builtin_key is null or builtin_key in ('classic', 'executive', 'sato', 'house', 'premium'));

comment on column public.offer_templates.builtin_key is
  'Which shipped design this row is a copy of (classic | executive | sato | house | premium), or null for a template built in the designer. Restore matches on this, never on name.';
comment on column public.offer_templates.variant is
  'The CSS skin the blocks are drawn in (classic | executive | sato | house | premium). All built-ins share one block list and one renderer; this chooses the visual identity.';

commit;
