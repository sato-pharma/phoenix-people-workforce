-- Tier-2 (NSM/GPM/PM) plan/punch mismatch flags.
--
-- The reconciliation engine (digest-reconcile.ts) already computes these as
-- "office_no_show" (plan says office, no punch) and "field_punch_anomaly"
-- (plan says field, but a punch exists) — per the confirmed spec, neither is
-- ever an auto-deduction. Both are surfaced to the employee's manager (cc HR +
-- CEO) for a human to resolve. This table is the durable record of that flag
-- and its resolution, distinct from attendance_digest_lines (which only ever
-- holds real deductible items) and attendance_settlements (which only ever
-- holds real deduction outcomes).

begin;

create table if not exists public.attendance_digest_flags (
  id              bigserial primary key,
  digest_id       bigint      not null references public.attendance_weekly_digests(id) on delete cascade,
  employee_hr_id  text        not null,
  work_date       date        not null,
  flag_type       text        not null check (flag_type in ('office_no_show', 'field_punch_anomaly')),
  reason          text        not null,
  notified_at     timestamptz null,
  resolved_at     timestamptz null,
  resolved_by     text        null,
  resolution_note text        null,
  created_at      timestamptz not null default now(),
  unique (digest_id, work_date, flag_type)
);
create index if not exists attendance_digest_flags_employee_idx
  on public.attendance_digest_flags (employee_hr_id, work_date);
create index if not exists attendance_digest_flags_unresolved_idx
  on public.attendance_digest_flags (resolved_at)
  where resolved_at is null;

alter table public.attendance_digest_flags enable row level security;
revoke all on table public.attendance_digest_flags from anon, authenticated;
grant select, insert, update on table public.attendance_digest_flags to service_role;
grant usage, select on sequence public.attendance_digest_flags_id_seq to service_role;

drop policy if exists attendance_digest_flags_service_role_all on public.attendance_digest_flags;
create policy attendance_digest_flags_service_role_all on public.attendance_digest_flags
  for all to service_role using (true) with check (true);

comment on table public.attendance_digest_flags is
  'Tier-2 (office-hybrid manager) plan/punch mismatches — never an auto-deduction, always routed to the manager (cc HR + CEO) for manual resolution.';

notify pgrst, 'reload schema';

commit;
