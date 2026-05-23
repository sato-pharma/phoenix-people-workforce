alter table public.outstation_expense_requests
  add column if not exists to_country text;

notify pgrst, 'reload schema';
