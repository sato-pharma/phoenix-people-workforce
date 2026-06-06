-- Reshape the Marketing Requests approval chain to the business-defined flow:
--   Manager chain (Direct Manager -> National Sales Manager, expanded per requester)
--   -> SFE (Validate / Return for edit / Reject)
--   -> Marketing Manager (Approve / Return / Decline; PM/GPM of the line are CC-notified)
--   -> CEO (Approve / Return / Reject)
--   -> Finance (Execute -> request goes live/active; or Return with a note; no reject).
--
-- The decision engine (approve/reject/return) is unchanged; this migration adds the
-- per-step configuration that drives chain shape, decision labels, CC roles, the
-- managerial-chain expansion, and the Finance terminal status.

-- 1) Template columns on marketing_workflow_steps -------------------------------------
alter table public.marketing_workflow_steps
  add column if not exists step_kind text not null default 'role';
alter table public.marketing_workflow_steps
  add column if not exists chain_target_role text null;
alter table public.marketing_workflow_steps
  add column if not exists cc_roles text[] not null default '{}';
alter table public.marketing_workflow_steps
  add column if not exists decision_labels jsonb not null
    default '{"approve":"Approve","return":"Return","reject":"Reject"}'::jsonb;
alter table public.marketing_workflow_steps
  add column if not exists terminal_status text null;
alter table public.marketing_workflow_steps
  add column if not exists allow_reject boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'marketing_workflow_steps_kind_check'
  ) then
    alter table public.marketing_workflow_steps
      add constraint marketing_workflow_steps_kind_check
      check (step_kind in ('managerial_chain', 'role', 'finance'));
  end if;
end $$;

-- 2) Per-request snapshot columns on marketing_request_approval_steps ------------------
alter table public.marketing_request_approval_steps
  add column if not exists step_kind text null;
alter table public.marketing_request_approval_steps
  add column if not exists decision_labels jsonb null;
alter table public.marketing_request_approval_steps
  add column if not exists terminal_status text null;
alter table public.marketing_request_approval_steps
  add column if not exists allow_reject boolean not null default true;
alter table public.marketing_request_approval_steps
  add column if not exists is_cc boolean not null default false;
alter table public.marketing_request_approval_steps
  add column if not exists executed_at timestamptz null;

-- 3) Lifecycle columns on marketing_requests ------------------------------------------
-- (status check already permits 'active' and 'returned'.)
alter table public.marketing_requests
  add column if not exists executed_at timestamptz null;
alter table public.marketing_requests
  add column if not exists returned_at timestamptz null;
alter table public.marketing_requests
  add column if not exists returned_step_sequence integer null;

-- 4) Reseed the workflow template into the target chain --------------------------------
-- The partial unique index marketing_workflow_steps_active_sequence_uidx forbids two
-- active rows sharing a sequence, so deactivate every step first, then upsert the new
-- set with active = true and distinct sequences.
update public.marketing_workflow_steps set active = false, updated_at = now();

insert into public.marketing_workflow_steps (
  step_code, step_name, sequence, approval_scope, assigned_role,
  step_kind, chain_target_role, cc_roles, decision_labels, terminal_status, allow_reject,
  required, active, default_sla_days
)
values
  ('manager_chain', 'Manager Approval', 1, 'direct_manager', 'Direct Manager',
   'managerial_chain', 'National Sales Manager', '{}',
   '{"approve":"Approve","return":"Return","reject":"Reject"}'::jsonb, null, true, true, true, 2),
  ('sfe_validation', 'SFE Validation', 2, 'role', 'SFE Manager',
   'role', null, '{}',
   '{"approve":"Validate","return":"Return for edit","reject":"Reject"}'::jsonb, null, true, true, true, 2),
  ('marketing_review', 'Marketing Review', 3, 'role', 'Marketing Manager',
   'role', null, '{Product Manager,Group Product Manager}',
   '{"approve":"Approve","return":"Return","reject":"Decline"}'::jsonb, null, true, true, true, 2),
  ('ceo_approval', 'CEO Approval', 4, 'final', 'CEO',
   'role', null, '{}',
   '{"approve":"Approve","return":"Return","reject":"Reject"}'::jsonb, null, true, true, true, 2),
  ('finance_execution', 'Finance Execution', 5, 'finance', 'Finance Manager',
   'finance', null, '{}',
   '{"approve":"Execute","return":"Return with a note","reject":"Reject"}'::jsonb, 'active', false, true, true, 2)
on conflict (step_code) do update set
  step_name = excluded.step_name,
  sequence = excluded.sequence,
  approval_scope = excluded.approval_scope,
  assigned_role = excluded.assigned_role,
  step_kind = excluded.step_kind,
  chain_target_role = excluded.chain_target_role,
  cc_roles = excluded.cc_roles,
  decision_labels = excluded.decision_labels,
  terminal_status = excluded.terminal_status,
  allow_reject = excluded.allow_reject,
  required = excluded.required,
  active = true,
  default_sla_days = excluded.default_sla_days,
  updated_at = now();

comment on column public.marketing_workflow_steps.step_kind is
  'managerial_chain expands at submit time into one step per manager up the requester chain (stops at chain_target_role); role/finance resolve a single line-scoped seat.';
comment on column public.marketing_workflow_steps.cc_roles is
  'Roles (by line) that are CC-notified for this step but do not gate it (e.g. Marketing = Product/Group Product Manager).';
comment on column public.marketing_request_approval_steps.is_cc is
  'CC rows are status=skipped, never gate, and are excluded from next-step selection.';
