-- A THIRD built-in offer design: the Sato corporate-identity letter.
--
-- WHY A MIGRATION AT ALL. The design itself lives in code (src/lib/offers/sato-template.ts) and
-- is seeded into `offer_templates` on demand by ensureBuiltinTemplates() — the seeder inserts any
-- built-in key not already present, so an environment that already holds `classic` and `executive`
-- picks up `sato` on the next request. The one thing code cannot do is widen the CHECK constraints
-- that 20260827091500 pinned to ('classic', 'executive'): a seed insert of variant/builtin_key
-- 'sato' is REFUSED by those constraints until this migration runs. So this migration must be
-- APPLIED BEFORE the code that seeds the row deploys — otherwise the seeder throws on the insert.
--
-- WHAT CHANGES. The two known-value constraints are dropped and re-added with 'sato' added to the
-- allowed set. Both new sets are supersets of the old ones, so every existing row (all classic or
-- executive) still satisfies them — the swap validates instantly and locks the tiny table only
-- briefly. Nothing else changes: no data is rewritten, and the two frozen designs are untouched.

begin;

-- The SKIN a row's blocks are drawn in. 'sato' is the corporate-identity design added beside the
-- two uploaded letters.
alter table public.offer_templates
  drop constraint if exists offer_templates_variant_known;
alter table public.offer_templates
  add constraint offer_templates_variant_known check (variant in ('classic', 'executive', 'sato'));

-- Which SHIPPED design a row is a copy of (the Restore anchor), or null for one built in the
-- designer.
alter table public.offer_templates
  drop constraint if exists offer_templates_builtin_key_known;
alter table public.offer_templates
  add constraint offer_templates_builtin_key_known
  check (builtin_key is null or builtin_key in ('classic', 'executive', 'sato'));

comment on column public.offer_templates.builtin_key is
  'Which shipped design this row is a copy of (classic | executive | sato), or null for a template built in the designer. Restore matches on this, never on name.';
comment on column public.offer_templates.variant is
  'The CSS skin the blocks are drawn in (classic | executive | sato). All built-ins share one block list and one renderer; this chooses the visual identity.';

commit;
