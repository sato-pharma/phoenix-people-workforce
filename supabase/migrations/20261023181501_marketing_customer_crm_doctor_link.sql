-- marketing_customer_crm_doctor_link
--
-- WHAT THIS CHANGES: four nullable columns on public.marketing_customers, nothing else.
--   * phoenix_crm_customer_id — the rep's Phoenix CRM doctor this marketing customer was picked from.
--   * crm_list_status         — 'on_list' (picked from a rep's CRM list) or 'not_on_list' (typed by
--                               hand because the doctor is not on the rep's list yet). NULL = a
--                               customer validated before this rule existed.
--   * chosen_area_seat_id / chosen_area_name — the area the validator chose BY HAND to open the
--                               doctor list. Kept apart on purpose: it never replaces the area the
--                               GPS capture resolved (extracted_area_name) or the customer's area_id.
-- WHY: owner, 2026-10-23 — Customer Validation no longer takes a free-typed doctor name. The validator
--   chooses the area, then the doctor from the reps' CRM lists of that area; a doctor not on the list
--   can still be typed, but is flagged on every approval step.
-- ROLLBACK:
--   alter table public.marketing_customers
--     drop column if exists chosen_area_name,
--     drop column if exists chosen_area_seat_id,
--     drop column if exists crm_list_status,
--     drop column if exists phoenix_crm_customer_id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Additive only: no row is rewritten, no existing column is touched.

begin;

alter table public.marketing_customers
  add column if not exists phoenix_crm_customer_id uuid
    references public.phoenix_crm_customers(id) on delete set null,
  add column if not exists crm_list_status text
    constraint marketing_customers_crm_list_status_check
    check (crm_list_status is null or crm_list_status in ('on_list', 'not_on_list')),
  add column if not exists chosen_area_seat_id text,
  add column if not exists chosen_area_name text;

create index if not exists marketing_customers_phoenix_crm_customer_idx
  on public.marketing_customers (phoenix_crm_customer_id)
  where phoenix_crm_customer_id is not null;

comment on column public.marketing_customers.phoenix_crm_customer_id is
  'The rep''s Phoenix CRM doctor this customer was picked from in Customer Validation (owner, 2026-10-23).';
comment on column public.marketing_customers.crm_list_status is
  'on_list = picked from a rep''s CRM list; not_on_list = typed by hand and flagged on every approval step; NULL = before 2026-10-23.';
comment on column public.marketing_customers.chosen_area_name is
  'The area the validator chose by hand to open the doctor list. Never replaces the GPS area.';

commit;
