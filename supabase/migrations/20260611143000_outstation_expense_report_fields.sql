alter table public.outstation_expense_requests
  add column if not exists report_trip_type text null,
  add column if not exists report_travel_cost double precision null,
  add column if not exists report_meeting_amount double precision not null default 0,
  add column if not exists report_other_amount double precision not null default 0,
  add column if not exists report_hr_status text null,
  add column if not exists report_hr_notes text null,
  add column if not exists report_am_workload double precision not null default 0,
  add column if not exists report_pm_workload double precision not null default 0;

comment on column public.outstation_expense_requests.report_trip_type is
  'Report-facing trip type label used in Phoenix outstation expense XLSX exports, for example Return same day or Overnight.';
comment on column public.outstation_expense_requests.report_travel_cost is
  'Report-facing travel cost override. When null, exports fall back to calculated fuel plus ticket amount.';
comment on column public.outstation_expense_requests.report_meeting_amount is
  'Report-facing meeting amount captured from admin or employee expense entry.';
comment on column public.outstation_expense_requests.report_other_amount is
  'Report-facing other amount captured from admin or employee expense entry.';
comment on column public.outstation_expense_requests.report_hr_status is
  'Report-facing HR review/status label for manual and exported expense records.';
comment on column public.outstation_expense_requests.report_hr_notes is
  'Report-facing HR notes for manual and exported expense records.';
comment on column public.outstation_expense_requests.report_am_workload is
  'Report-facing AM workload value captured for expense reporting.';
comment on column public.outstation_expense_requests.report_pm_workload is
  'Report-facing PM workload value captured for expense reporting.';

alter table public.payroll_expenses
  add column if not exists other_amount numeric(20, 2) not null default 0;

comment on column public.payroll_expenses.other_amount is
  'Report-facing Other amount from the unified outstation expense report. Included in Travel Cost + Meeting Amount + Allowance + Other = Total.';

notify pgrst, 'reload schema';
