-- Attendance exceptions / overrides.
--
-- Allows HR to approve or reject employee-disputed attendance records, and for HR
-- to proactively create exceptions (e.g. approved field visits, off-site missions).
-- An approved exception row for a given (employee_hr_id, exception_date) instructs
-- the fingerprint-report engine to zero out the deduction flags for that day.
--
-- Employee-initiated disputes land here with status='pending'; HR reviews and either
-- approves (suppresses deduction) or rejects (deduction stands).
--
-- The unique constraint on (employee_hr_id, exception_date) means at most one live
-- exception per employee per day.  ON CONFLICT DO UPDATE semantics in the service
-- allow safe re-submission if an employee re-disputes after a rejection.

begin;

create table if not exists public.attendance_exceptions (
  id                bigserial primary key,
  employee_hr_id    text        not null,
  exception_date    date        not null,
  reason            text        not null,
  status            text        not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
  requested_by      text        not null,
  reviewed_by       text        null,
  reviewed_at       timestamptz null,
  notes             text        null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_hr_id, exception_date)
);

-- Indexes for common access patterns.
create index if not exists attendance_exceptions_employee_date_idx
  on public.attendance_exceptions (employee_hr_id, exception_date);

create index if not exists attendance_exceptions_pending_idx
  on public.attendance_exceptions (status)
  where status = 'pending';

-- RLS: service-role (admin client) handles all writes; anon/authenticated key
-- is not used for attendance tables.
alter table public.attendance_exceptions enable row level security;

-- Allow service-role (used by the Phoenix API) unrestricted access.
create policy "service_role_all" on public.attendance_exceptions
  as permissive for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
