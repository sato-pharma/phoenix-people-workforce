-- offer_prestige_design_and_product_manager
--
-- WHAT THIS CHANGES:
--   1. A SIXTH built-in offer design, 'prestige' ("SATO Prestige Offer", the engraved letter), is
--      allowed by the two CHECK constraints that gate offer_templates.variant and .builtin_key.
--   2. The Job Titles catalogue gains a Product Manager row, with its own words.
--
-- WHY: the owner asked on 17 Nov 2026 for an offer tailored to the Product Manager, reporting to
--   the Marketing Manager or a Group Product Manager as he chooses, "very premium polished". The
--   design itself lives in code (src/lib/offers/prestige-template.ts, prestige-skin.ts) and is
--   seeded into offer_templates on demand by ensureBuiltinTemplates(), which inserts any built-in
--   key not already present and, on that first insert, points the Product Manager title at it. The
--   one thing code cannot do is widen the CHECK constraints, so the seed insert of 'prestige' is
--   REFUSED until this runs.
--
-- ORDER MATTERS: apply this to STAGING and to PRODUCTION BEFORE the code that registers the design
--   deploys. Railway applies no migrations, and ensureBuiltinTemplates() THROWS when the insert is
--   refused, so a deploy that lands first breaks the offer designer's template list until this runs.
--
-- THE CONSTRAINTS are dropped and re-added with 'prestige' added to the set they already allow
--   ('classic', 'executive', 'sato', 'house', 'premium'). The new set is a superset of the current
--   one, so every existing row still satisfies it and the swap validates instantly. No template row
--   is rewritten, and the five existing designs are untouched.
--
-- THE TITLE: cost of living 3,500 is payroll's own pair for the title (3,000 allowance + 500 fuel,
--   src/lib/payroll/salary-autofill.ts), as for the Training Manager. Reports-to starts on the
--   Marketing Manager; the offer form offers the Group Product Manager beside it with one press.
--   The words match OFFER_PRODUCT_MANAGER_ROLE_SUMMARY in src/lib/offers/role-summary.ts exactly
--   (chr(8212) is the em dash, chr(8217) the apostrophe, chr(10) the line break). `on conflict do
--   nothing` plus the NULL guard mean re-running this never overwrites anything HR has since typed.
--
-- ROLLBACK: re-run the two constraint statements of 20261013120000_job_offer_premium_variant.sql
--   (after deleting any offer_templates row whose variant is 'prestige'), and delete the Product
--   Manager row from offer_job_titles if no offer has used it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one constraint swap that validates against the same rows,
-- one inserted row, one guarded update of that row.

begin;

alter table public.offer_templates
  drop constraint if exists offer_templates_variant_known;
alter table public.offer_templates
  add constraint offer_templates_variant_known
  check (variant in ('classic', 'executive', 'sato', 'house', 'premium', 'prestige'));

alter table public.offer_templates
  drop constraint if exists offer_templates_builtin_key_known;
alter table public.offer_templates
  add constraint offer_templates_builtin_key_known
  check (builtin_key is null or builtin_key in ('classic', 'executive', 'sato', 'house', 'premium', 'prestige'));

comment on column public.offer_templates.builtin_key is
  'Which shipped design this row is a copy of (classic | executive | sato | house | premium | prestige), or null for a template built in the designer. Restore matches on this, never on name.';
comment on column public.offer_templates.variant is
  'The CSS skin the blocks are drawn in (classic | executive | sato | house | premium | prestige). All built-ins share one block list and one renderer; this chooses the visual identity.';

insert into public.offer_job_titles (title, cost_of_living, reports_to, contract_term)
values ('Product Manager', 3500, 'Marketing Manager', 'One year, renewable')
on conflict do nothing;

update public.offer_job_titles
set role_summary =
  'Throughout our selection process you demonstrated the strategic thinking, the scientific depth and '
  || 'the commercial judgement this role calls for, and we would like you to bring all three to our '
  || 'Marketing team.' || chr(10) || chr(10)
  || 'As Product Manager, you will own the strategy and the brand plan for your portfolio ' || chr(8212)
  || ' building its positioning and key messages from real market and customer insight, partnering with key '
  || 'opinion leaders and medical experts, and serving as the field force' || chr(8217) || 's authority on your products: '
  || 'training our teams on the products, the diseases they treat and the key messages, and testing '
  || 'their product knowledge. Working closely with Sales Management, you will turn each brand plan into '
  || 'growth that our people in the field can deliver.'
where role_summary is null
  and lower(btrim(title)) = 'product manager';

commit;
