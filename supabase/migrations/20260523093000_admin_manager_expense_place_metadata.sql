begin;

-- Add destination metadata needed for admin-created manager expenses.
alter table public.outstation_expense_requests
  add column if not exists to_country text;

alter table public.outstation_expense_requests
  add column if not exists to_place_id text;

create index if not exists outstation_expense_requests_to_place_id_idx
  on public.outstation_expense_requests (to_place_id);

create index if not exists outstation_expense_requests_to_country_idx
  on public.outstation_expense_requests (to_country);

commit;
