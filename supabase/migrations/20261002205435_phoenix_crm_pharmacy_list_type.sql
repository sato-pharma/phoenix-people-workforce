-- Phoenix CRM — a pharmacy is a THIRD list_type, so the two tables that hold one must accept it.
--
-- 20261002150353 widened `phoenix_crm_seat_reference` so each rep's iReports360 pharmacies come
-- across beside his AM and PM contacts. That is only half the import: every table the mint and the
-- visit then write to still carries `check (list_type in ('AM', 'PM'))`, so
-- `phoenix_crm_ensure_reference_customers` would raise 23514 on the first pharmacy row and a visit to
-- one could never be saved at all. Found 2026-10-02 by reading the live constraints rather than the
-- code (AGENTS.md §1: verify against the database, not the plan).
--
-- 🔴 `phoenix_crm_plan_items` IS DELIBERATELY LEFT NARROW, AND THAT IS NOT AN OVERSIGHT. The owner's
-- ruling of 2026-10-02 is that a pharmacy is NEVER planned — *"He can add any pharmacy, any time …
-- He don't plan it. We don't want extra"* — so a pharmacy on a plan row is not a feature waiting to
-- be enabled, it is the thing that must not happen. Its `check (list_type in ('AM', 'PM'))` is now
-- the database's own half of that rule, under the TypeScript one
-- (`src/lib/phoenix-crm/pharmacy-call-rules.ts` `PLANNABLE_LIST_TYPES`). Widening it would quietly
-- remove the only mechanical guard the ruling has. `phoenix_crm_list_requests` stays narrow for the
-- same reason: a pharmacy arrives as a reference and leaves as one, with no grade, drop, add or
-- bring-back request to decide.
--
-- Rollback: re-narrow both, after deleting the pharmacy rows they then hold.
--   delete from public.phoenix_crm_visits where list_type = 'Pharmacy';
--   delete from public.phoenix_crm_customers where list_type = 'Pharmacy';
--   then the two alters below with ARRAY['AM', 'PM'].

-- One transaction, a 5s lock ceiling, and PostgREST told to re-read the schema (the module contract).
begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_customers
  drop constraint if exists phoenix_crm_customers_list_type;

alter table public.phoenix_crm_customers
  add constraint phoenix_crm_customers_list_type
  check (list_type in ('AM', 'PM', 'Pharmacy'));

alter table public.phoenix_crm_visits
  drop constraint if exists phoenix_crm_visits_list_type;

alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_list_type
  check (list_type in ('AM', 'PM', 'Pharmacy'));

comment on constraint phoenix_crm_customers_list_type on public.phoenix_crm_customers is
  'AM, PM and (2026-10-02) Pharmacy. A pharmacy is a reference the rep calls on: never planned, in no '
  'KPI, and counted apart from the doctors (the AM · PM · Pharmacies golden rule).';

comment on constraint phoenix_crm_visits_list_type on public.phoenix_crm_visits is
  'AM, PM and (2026-10-02) Pharmacy. A pharmacy call needs no plan and no approval, and counts in no '
  'rate — only in the Pharmacies figure, which is a plain count.';

comment on constraint phoenix_crm_plan_items_list_type on public.phoenix_crm_plan_items is
  'AM and PM ONLY, deliberately: the owner ruled on 2026-10-02 that a pharmacy is never planned. Do '
  'not widen this to Pharmacy — it is the database''s own half of that rule.';

-- Without this PostgREST keeps its old schema cache, and the app reads the new shape as missing.
notify pgrst, 'reload schema';

commit;
