-- P2-07: single source-of-truth transition matrix for payroll workflow.
-- The DB trigger and the application both validate against this table, so
-- the allowed transitions can never silently diverge.

create table if not exists public.payroll_workflow_transitions (
  from_status text not null,
  action      text not null,
  to_status   text not null,
  primary key (from_status, action)
);

-- Seed: mirrors payrollTransitions in src/lib/payroll/workflow.ts exactly.
-- Any change here must also be reflected in that TypeScript file and vice versa.
insert into public.payroll_workflow_transitions (from_status, action, to_status) values
  ('uploaded',         'mark_part1_ready',  'part1_ready'),
  ('part1_ready',      'mark_part1_paid',   'part1_paid'),
  ('part1_paid',       'open_adjustments',  'adjustments_open'),
  ('adjustments_open', 'mark_part2_ready',  'part2_ready'),
  ('part2_ready',      'mark_review',       'under_review'),
  ('under_review',     'approve',           'approved'),
  ('under_review',     'reject',            'rejected'),
  ('rejected',         'reopen',            'adjustments_open'),
  ('approved',         'lock',              'locked')
on conflict (from_status, action) do update
  set to_status = excluded.to_status;

-- Service-role read access only; nobody inserts transitions at runtime
revoke all on table public.payroll_workflow_transitions from public, anon, authenticated;
grant select on table public.payroll_workflow_transitions to service_role;

-- Helper function used by both the trigger and (optionally) the application
create or replace function public.phx_is_valid_payroll_transition(
  p_from_status text,
  p_to_status   text
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.payroll_workflow_transitions
    where from_status = p_from_status
      and to_status   = p_to_status
  )
$$;

-- Replace the hardcoded trigger with a matrix-backed version.
-- Locked state: all field updates blocked (no outgoing transitions in matrix).
-- Status changes: must exist in payroll_workflow_transitions.
-- Non-status field updates on non-locked rows: allowed (approved_at, etc.).
create or replace function public.phx_prevent_closed_salary_batch_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Completely frozen once locked — no field may change
  if old.status = 'locked' then
    raise exception
      'Payroll batch cannot be updated while status is %.',
      old.status
    using errcode = 'P0001';
  end if;

  -- When status changes, validate against the transition matrix
  if old.status is distinct from new.status then
    if not public.phx_is_valid_payroll_transition(old.status, new.status) then
      raise exception
        'Invalid payroll workflow transition: % → %.',
        old.status, new.status
      using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- Trigger already exists from the previous migration; recreate to pick up
-- the new function body.
drop trigger if exists phx_prevent_closed_salary_batch_update on public.salary_batches;
create trigger phx_prevent_closed_salary_batch_update
before update on public.salary_batches
for each row
execute function public.phx_prevent_closed_salary_batch_update();

revoke all on function public.phx_is_valid_payroll_transition(text, text)
  from public, anon, authenticated;
grant execute on function public.phx_is_valid_payroll_transition(text, text)
  to service_role;

revoke all on function public.phx_prevent_closed_salary_batch_update()
  from public, anon, authenticated;
