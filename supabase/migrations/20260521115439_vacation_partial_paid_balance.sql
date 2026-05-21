alter table public.v2_vacation_requests
  add column if not exists paid_duration_days numeric(8,2) not null default 0,
  add column if not exists unpaid_duration_days numeric(8,2) not null default 0;

update public.v2_vacation_requests
set
  paid_duration_days = case
    when payment_status = 'paid' then duration_days
    else 0
  end,
  unpaid_duration_days = case
    when payment_status = 'unpaid' then duration_days
    else 0
  end
where paid_duration_days = 0
  and unpaid_duration_days = 0;

alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_payment_status_check;

alter table public.v2_vacation_requests
  add constraint v2_vacation_requests_payment_status_check
  check (payment_status in ('paid', 'partial', 'unpaid'));

alter table public.v2_vacation_requests
  add constraint v2_vacation_requests_paid_unpaid_duration_check
  check (
    paid_duration_days >= 0
    and unpaid_duration_days >= 0
    and round((paid_duration_days + unpaid_duration_days)::numeric, 2) = round(duration_days::numeric, 2)
  );
