-- Direct Order Request module — foundation (Phase A).
--
-- Governed capture + sequential approval (requester → actual managers up the sales
-- line → CEO) for company "direct" orders that today live in a free-text Excel and
-- reach Sales only at region level (no rep/DM credit). Single line per request.
--
-- Tables (all RLS-enabled with NO policies → service-role-only; the browser never
-- reads these directly, the server uses getSupabaseAdmin()):
--   * direct_order_pharmacies      — reusable, auto-coded pharmacy registry
--   * direct_order_requests        — one product+pharmacy line + lifecycle
--   * direct_order_approval_steps  — the ordered approval ledger (mirrors v2_vacation_approval_steps)
--   * direct_order_events          — user-facing timeline
-- Atomic decision RPC phx_apply_direct_order_decision (status compare-and-swap,
-- mirrors phx_apply_vacation_paid_approval).
--
-- Money invariants enforced here: sales_value is stored (service computes
-- qty × factory_price, bonus excluded); bonus is a separate capped field.

begin;

-- Pharmacy code sequence (DOP-000001 …). Auto-assigned on insert when not supplied.
create sequence if not exists public.direct_order_pharmacy_code_seq;

-- ── 1. Pharmacy registry ─────────────────────────────────────────────────────
create table if not exists public.direct_order_pharmacies (
  id uuid primary key default gen_random_uuid(),
  phoenix_pharmacy_code text not null unique
    default ('DOP-' || lpad(nextval('public.direct_order_pharmacy_code_seq')::text, 6, '0')),
  pharmacy_name text not null,
  brick_id text,
  area_code text,
  region_code text,
  doctor_name text,
  pharmacy_address text,
  distributor_code text,
  distributor_customer_code text,
  created_by_hr_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists direct_order_pharmacies_created_by_idx
  on public.direct_order_pharmacies (created_by_hr_id) where active;
create index if not exists direct_order_pharmacies_area_idx
  on public.direct_order_pharmacies (area_code);

-- ── 2. Requests (single line each) ───────────────────────────────────────────
create table if not exists public.direct_order_requests (
  id uuid primary key default gen_random_uuid(),
  requester_hr_id text not null,
  requester_role text not null,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'returned', 'reversed')),
  line text not null,
  product_code text not null,
  product_name text not null,
  factory_price_snapshot numeric(18,6) not null check (factory_price_snapshot >= 0),
  qty numeric(18,3) not null check (qty > 0),
  bonus numeric(18,3) not null default 0 check (bonus >= 0),
  bonus_override_reason text,
  -- Always qty × factory_price_snapshot (bonus excluded); persisted for audit + injection.
  sales_value numeric(18,2) not null check (sales_value >= 0),
  pharmacy_id uuid not null references public.direct_order_pharmacies (id),
  -- YYYY-MM; set to the CEO-final-approval month on final approval.
  sales_month text check (sales_month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- Expected money-collection date, entered by the requester at submit (تاريخ التحصيل).
  collection_date date,
  marketing_request_id uuid,
  -- Finance-editable ACTUAL collections fields (post-approval, outside the approval gate).
  payment_date date,
  paid_amount numeric(18,2),
  remaining_amount numeric(18,2),
  -- Injection + reversal bookkeeping (Phase C).
  sos_batch_id uuid,
  reversal_of_request_id uuid references public.direct_order_requests (id),
  reversed_by_request_id uuid references public.direct_order_requests (id),
  submitted_at timestamptz,
  decided_at timestamptz,
  created_by_login_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists direct_order_requests_requester_idx
  on public.direct_order_requests (requester_hr_id, status);
create index if not exists direct_order_requests_status_idx
  on public.direct_order_requests (status);
create index if not exists direct_order_requests_pharmacy_idx
  on public.direct_order_requests (pharmacy_id);
create index if not exists direct_order_requests_sales_month_idx
  on public.direct_order_requests (sales_month) where status = 'approved';
create index if not exists direct_order_requests_marketing_idx
  on public.direct_order_requests (marketing_request_id) where marketing_request_id is not null;

-- ── 3. Approval steps (ordered ledger) ───────────────────────────────────────
create table if not exists public.direct_order_approval_steps (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.direct_order_requests (id) on delete cascade,
  step_order int not null,
  approver_kind text not null check (approver_kind in ('person', 'role')),
  approver_role text,
  approver_hr_id text,
  label text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decision_comment text,
  decided_by_hr_id text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_order_approval_steps_decision_ts_check
    check (((status = 'pending') and (decided_at is null))
           or ((status in ('approved', 'rejected')) and (decided_at is not null))),
  constraint direct_order_approval_steps_approver_shape_check
    check ((approver_kind = 'person' and approver_hr_id is not null)
           or (approver_kind = 'role' and approver_role is not null)),
  unique (request_id, step_order)
);

create index if not exists direct_order_approval_steps_request_idx
  on public.direct_order_approval_steps (request_id, step_order);
create index if not exists direct_order_approval_steps_approver_idx
  on public.direct_order_approval_steps (approver_hr_id, status) where approver_hr_id is not null;

-- ── 4. Timeline ──────────────────────────────────────────────────────────────
create table if not exists public.direct_order_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.direct_order_requests (id) on delete cascade,
  actor_hr_id text,
  event_type text not null,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists direct_order_events_request_idx
  on public.direct_order_events (request_id, created_at);

-- Idempotent column adds (safe when the tables already exist from an earlier apply).
alter table public.direct_order_pharmacies add column if not exists pharmacy_address text;
alter table public.direct_order_requests   add column if not exists collection_date date;

-- ── RLS: enable, NO policies (service-role-only) ─────────────────────────────
alter table public.direct_order_pharmacies enable row level security;
alter table public.direct_order_requests enable row level security;
alter table public.direct_order_approval_steps enable row level security;
alter table public.direct_order_events enable row level security;

-- ── Atomic decision RPC (status compare-and-swap; mirrors vacation) ──────────
-- Applies one approver's decision to one step and advances the request status in a
-- single transaction. p_next_status / p_step_next_status come from the pure
-- approval-flow evaluation in TS; this function only guarantees atomicity +
-- optimistic concurrency (no business logic duplicated here).
create or replace function public.phx_apply_direct_order_decision(
  p_request_id uuid,
  p_step_order int,
  p_expected_status text,
  p_next_status text,
  p_step_next_status text,      -- 'approved' | 'rejected' | null (null = return: request-only, step untouched)
  p_decided_by_hr_id text,
  p_decision_comment text,
  p_now timestamptz,
  p_sales_month text            -- set only when the request finalizes as approved
) returns public.direct_order_requests
  language plpgsql security definer
  set search_path to 'public'
as $$
declare
  v_row public.direct_order_requests;
  v_is_final boolean;
begin
  select * into v_row from public.direct_order_requests where id = p_request_id for update;
  if not found then
    raise exception 'Direct order request was not found.' using errcode = 'P0002';
  end if;
  if v_row.status is distinct from p_expected_status then
    raise exception 'Direct order request was updated by another user. Refresh and try again.'
      using errcode = '40001';
  end if;

  -- Advance the acting step (only for approve/reject; a return leaves the step
  -- pending so the chain resumes at the same rung after the requester resubmits).
  if p_step_next_status in ('approved', 'rejected') then
    update public.direct_order_approval_steps
       set status = p_step_next_status,
           decided_by_hr_id = p_decided_by_hr_id,
           decision_comment = p_decision_comment,
           decided_at = p_now,
           updated_at = p_now
     where request_id = p_request_id and step_order = p_step_order;
    if not found then
      raise exception 'Approval step % was not found for this request.', p_step_order using errcode = 'P0002';
    end if;
  end if;

  v_is_final := p_next_status in ('approved', 'rejected');

  update public.direct_order_requests
     set status = p_next_status,
         decided_at = case when v_is_final then p_now else decided_at end,
         sales_month = case when p_next_status = 'approved' then p_sales_month else sales_month end,
         updated_at = p_now
   where id = p_request_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.phx_apply_direct_order_decision(uuid, int, text, text, text, text, text, timestamptz, text) from public;
grant execute on function public.phx_apply_direct_order_decision(uuid, int, text, text, text, text, text, timestamptz, text) to service_role;

-- ── Workflow registry governance module ─────────────────────────────────────
insert into public.workflow_registry_modules (
  module_key, module_name, description, statuses, actions, is_active, created_by, updated_by
)
values (
  'direct_orders',
  'Direct Orders',
  'Direct (company) order request submission and sequential approval up the sales line to the CEO, with reversal.',
  '[
    {"key":"draft","label":"Draft","terminal":false},
    {"key":"pending_approval","label":"Pending Approval","terminal":false},
    {"key":"returned","label":"Returned","terminal":false},
    {"key":"approved","label":"Approved","terminal":false},
    {"key":"rejected","label":"Rejected","terminal":true},
    {"key":"reversed","label":"Reversed","terminal":true}
  ]'::jsonb,
  '[
    {"key":"submit","label":"Requester submits direct order","from":["draft","returned"],"to":"pending_approval","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","Super Admin"],"requiresReason":false,"sideEffects":["seed approval chain"],"notifications":["notify first approver + SFE + system admin"],"auditLog":"Direct order submitted","tests":["direct order submit is registry-controlled"]},
    {"key":"approve_intermediate","label":"Manager approves (more rungs remain)","from":["pending_approval"],"to":"pending_approval","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Super Admin"],"requiresReason":false,"sideEffects":["advance to next approver"],"notifications":["notify requester + next approver + CC"],"auditLog":"Direct order approved (intermediate)","tests":["intermediate approval advances the chain"]},
    {"key":"approve_final","label":"CEO gives final approval","from":["pending_approval"],"to":"approved","allowedRoles":["CEO","Super Admin"],"requiresReason":false,"sideEffects":["finalize + set sales month + inject sales"],"notifications":["notify requester + CC"],"auditLog":"Direct order approved (final)","tests":["only CEO finalizes"]},
    {"key":"reject","label":"Approver rejects","from":["pending_approval"],"to":"rejected","allowedRoles":["District Manager","Regional Manager","National Sales Manager","CEO","Super Admin"],"requiresReason":true,"sideEffects":["close request"],"notifications":["notify requester + CC"],"auditLog":"Direct order rejected","tests":["rejection is final"]},
    {"key":"return","label":"Approver returns for edit","from":["pending_approval"],"to":"returned","allowedRoles":["District Manager","Regional Manager","National Sales Manager","CEO","Super Admin"],"requiresReason":true,"sideEffects":["return to requester"],"notifications":["notify requester + CC"],"auditLog":"Direct order returned","tests":["return sends back to requester"]},
    {"key":"reverse","label":"Reverse an approved direct order","from":["approved"],"to":"reversed","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","Super Admin"],"requiresReason":true,"sideEffects":["create reversing entry for re-approval"],"notifications":["notify approvers + CC"],"auditLog":"Direct order reversed","tests":["reversal requires re-approval"]}
  ]'::jsonb,
  true, 'system', 'system'
)
on conflict (module_key) do update set
  module_name = excluded.module_name,
  description = excluded.description,
  statuses = excluded.statuses,
  actions = excluded.actions,
  is_active = excluded.is_active,
  updated_by = 'system';

notify pgrst, 'reload schema';

commit;
