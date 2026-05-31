create table if not exists public.workflow_registry_modules (
  id uuid primary key default gen_random_uuid(),
  module_key text not null,
  module_name text not null,
  description text not null default '',
  statuses jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  version integer not null default 1,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_registry_modules_key_unique unique (module_key),
  constraint workflow_registry_modules_key_format check (module_key ~ '^[a-z][a-z0-9_]*$'),
  constraint workflow_registry_modules_statuses_array check (jsonb_typeof(statuses) = 'array'),
  constraint workflow_registry_modules_actions_array check (jsonb_typeof(actions) = 'array')
);

create index if not exists workflow_registry_modules_active_idx
  on public.workflow_registry_modules (is_active, module_key);

alter table public.workflow_registry_modules enable row level security;

revoke all on table public.workflow_registry_modules from public, anon, authenticated;
grant select, insert, update, delete on table public.workflow_registry_modules to service_role;

drop policy if exists workflow_registry_modules_service_role_all on public.workflow_registry_modules;
create policy workflow_registry_modules_service_role_all
  on public.workflow_registry_modules
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.phx_touch_workflow_registry_module()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  if tg_op = 'UPDATE' then
    new.version = coalesce(old.version, 1) + 1;
  end if;
  return new;
end;
$$;

revoke all on function public.phx_touch_workflow_registry_module() from public, anon, authenticated;
grant execute on function public.phx_touch_workflow_registry_module() to service_role;

drop trigger if exists workflow_registry_modules_touch on public.workflow_registry_modules;
create trigger workflow_registry_modules_touch
  before update on public.workflow_registry_modules
  for each row
  execute function public.phx_touch_workflow_registry_module();

insert into public.workflow_registry_modules (
  module_key,
  module_name,
  description,
  statuses,
  actions,
  is_active,
  created_by,
  updated_by
)
values
  (
    'outstation_expenses',
    'Outstation Expenses',
    'Unified workflow for historical uploaded expenses and live outstation expense requests.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"pending","label":"Pending Approval","terminal":false},
      {"key":"approved","label":"Approved","terminal":false},
      {"key":"rejected","label":"Rejected","terminal":true},
      {"key":"added_to_payroll","label":"Added to Payroll","terminal":true}
    ]'::jsonb,
    '[
      {
        "key":"submit",
        "label":"Submit expense",
        "from":["draft"],
        "to":"pending",
        "allowedRoles":["Employee","Medical Rep","District Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Manager","Super Admin","HR Specialist","Finance Manager","CEO"],
        "sideEffects":["capture employee, trip, GPS, and calculated amount"],
        "notifications":["notify approvers when request is pending"],
        "auditLog":"Expense submitted",
        "tests":["employee can submit live expense","submitted expense remains outside payroll until approval"]
      },
      {
        "key":"approve",
        "label":"Approve expense",
        "from":["pending"],
        "to":"approved",
        "allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],
        "sideEffects":["set approved_by and approved_at","make expense eligible for manual payroll import"],
        "notifications":["notify employee that expense was approved"],
        "auditLog":"Expense approved",
        "tests":["only authorized roles can approve","approval does not automatically add to payroll"]
      },
      {
        "key":"reject",
        "label":"Reject expense",
        "from":["pending"],
        "to":"rejected",
        "allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],
        "sideEffects":["store rejection reason"],
        "notifications":["notify employee that expense was rejected"],
        "auditLog":"Expense rejected",
        "tests":["rejected expense is excluded from payroll import"]
      },
      {
        "key":"add_to_payroll",
        "label":"Add to payroll",
        "from":["approved"],
        "to":"added_to_payroll",
        "allowedRoles":["Super Admin","HR Specialist","Finance Manager"],
        "sideEffects":["lock edit/delete","link expense to payroll run"],
        "notifications":["optional payroll completion notification"],
        "auditLog":"Expense added to payroll",
        "tests":["expense cannot be deleted after payroll import"]
      },
      {
        "key":"delete_before_payroll",
        "label":"Delete before payroll",
        "from":["draft","pending","approved","rejected"],
        "to":"deleted",
        "allowedRoles":["Super Admin","HR Specialist","Finance Manager"],
        "sideEffects":["remove or soft-delete expense before payroll lock"],
        "notifications":["optional employee/admin notification"],
        "auditLog":"Expense deleted before payroll",
        "tests":["approved expense can be deleted before payroll","payroll locked expense cannot be deleted"]
      }
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'payroll_batches',
    'Payroll Batches',
    'Payroll upload, review, approval, payslip generation, and locked batch lifecycle.',
    '[
      {"key":"uploaded","label":"Uploaded","terminal":false},
      {"key":"part1_ready","label":"Part 1 Ready","terminal":false},
      {"key":"part1_paid","label":"Part 1 Paid","terminal":false},
      {"key":"adjustments_open","label":"Adjustments Open","terminal":false},
      {"key":"part2_ready","label":"Part 2 Ready","terminal":false},
      {"key":"under_review","label":"Under Review","terminal":false},
      {"key":"approved","label":"Approved","terminal":false},
      {"key":"locked","label":"Locked","terminal":true},
      {"key":"rejected","label":"Rejected","terminal":true}
    ]'::jsonb,
    '[
      {"key":"mark_part1_ready","label":"Mark Part 1 ready","from":["uploaded"],"to":"part1_ready","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["freeze initial upload for Part 1 review"],"notifications":["notify payroll admins"],"auditLog":"Payroll Part 1 marked ready","tests":["uploaded payroll can move to Part 1 ready"]},
      {"key":"mark_part1_paid","label":"Mark Part 1 paid","from":["part1_ready"],"to":"part1_paid","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["record part1_paid_by and part1_paid_at"],"notifications":["notify payroll admins"],"auditLog":"Payroll Part 1 marked paid","tests":["Part 1 ready payroll can be marked paid"]},
      {"key":"open_adjustments","label":"Open adjustments","from":["part1_paid"],"to":"adjustments_open","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["open Part 2 adjustment window"],"notifications":["notify payroll admins"],"auditLog":"Payroll adjustments opened","tests":["Part 1 paid payroll can open adjustments"]},
      {"key":"mark_part2_ready","label":"Mark Part 2 ready","from":["adjustments_open"],"to":"part2_ready","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["record part2_ready_by and part2_ready_at"],"notifications":["notify payroll reviewers"],"auditLog":"Payroll Part 2 marked ready","tests":["adjustments can move to Part 2 ready"]},
      {"key":"mark_review","label":"Send to review","from":["part2_ready"],"to":"under_review","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["move payroll to final review"],"notifications":["notify approvers"],"auditLog":"Payroll sent to review","tests":["Part 2 ready payroll can move under review"]},
      {"key":"approve","label":"Approve batch","from":["under_review"],"to":"approved","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["set approved_by and approved_at"],"notifications":["notify payroll owner"],"auditLog":"Payroll batch approved","tests":["approval requires authorized role"]},
      {"key":"lock","label":"Lock batch","from":["approved"],"to":"locked","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["set locked_at and lock payroll edits"],"notifications":["notify employees when payslips are ready"],"auditLog":"Payroll batch locked","tests":["locked payroll cannot be replaced silently"]},
      {"key":"reject","label":"Reject batch","from":["under_review"],"to":"rejected","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["store rejected_reason"],"notifications":["notify payroll owner"],"auditLog":"Payroll batch rejected","tests":["reject requires a reason"]},
      {"key":"reopen","label":"Reopen rejected batch","from":["rejected"],"to":"adjustments_open","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["clear rejected_reason and Part 2 ready markers"],"notifications":["notify payroll admins"],"auditLog":"Payroll batch reopened","tests":["rejected payroll can reopen to adjustments"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'leave_requests',
    'Leave Requests',
    'Employee vacation and leave approval workflow.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"pending","label":"Pending","terminal":false},
      {"key":"approved","label":"Approved","terminal":true},
      {"key":"rejected","label":"Rejected","terminal":true},
      {"key":"cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"submit","label":"Submit leave","from":["draft"],"to":"pending","allowedRoles":["Employee","Medical Rep","District Manager","Manager"],"sideEffects":["reserve requested dates"],"notifications":["notify manager or HR"],"auditLog":"Leave request submitted","tests":["employee can submit within policy"]},
      {"key":"approve","label":"Approve leave","from":["pending"],"to":"approved","allowedRoles":["Super Admin","HR Specialist","District Manager","Manager","CEO"],"sideEffects":["consume leave balance"],"notifications":["notify employee"],"auditLog":"Leave request approved","tests":["approved leave reduces balance"]},
      {"key":"reject","label":"Reject leave","from":["pending"],"to":"rejected","allowedRoles":["Super Admin","HR Specialist","District Manager","Manager","CEO"],"sideEffects":["release reserved days"],"notifications":["notify employee"],"auditLog":"Leave request rejected","tests":["rejected leave does not reduce balance"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'employee_lifecycle',
    'Employee Lifecycle',
    'Resignation, probation, contract renewal, offers, and hiring-document workflow governance.',
    '[
      {"key":"open","label":"Open","terminal":false},
      {"key":"manager_review","label":"Manager Review","terminal":false},
      {"key":"hr_review","label":"HR Review","terminal":false},
      {"key":"approved","label":"Approved","terminal":false},
      {"key":"completed","label":"Completed","terminal":true},
      {"key":"rejected","label":"Rejected","terminal":true}
    ]'::jsonb,
    '[
      {"key":"submit","label":"Submit lifecycle action","from":["open"],"to":"manager_review","allowedRoles":["Employee","Medical Rep","District Manager","Manager","HR Specialist","Super Admin"],"sideEffects":["create lifecycle record"],"notifications":["notify next reviewer"],"auditLog":"Lifecycle workflow submitted","tests":["submit creates auditable workflow record"]},
      {"key":"manager_approve","label":"Manager approve","from":["manager_review"],"to":"hr_review","allowedRoles":["District Manager","Manager","Regional Manager","National Sales Manager","Super Admin"],"sideEffects":["capture manager decision"],"notifications":["notify HR"],"auditLog":"Manager lifecycle approval","tests":["manager approval moves to HR review"]},
      {"key":"hr_complete","label":"HR complete","from":["hr_review","approved"],"to":"completed","allowedRoles":["HR Specialist","Super Admin"],"sideEffects":["finalize employee lifecycle state"],"notifications":["notify stakeholders"],"auditLog":"Lifecycle workflow completed","tests":["completion writes audit log"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'marketing_requests',
    'Marketing Requests',
    'Marketing request and HCP/PH validation workflow governance.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"submitted","label":"Submitted","terminal":false},
      {"key":"validation","label":"Validation","terminal":false},
      {"key":"approved","label":"Approved","terminal":true},
      {"key":"rejected","label":"Rejected","terminal":true}
    ]'::jsonb,
    '[
      {"key":"submit","label":"Submit request","from":["draft"],"to":"submitted","allowedRoles":["Medical Rep","District Manager","Product Manager","Marketing Manager","SFE Manager","Super Admin"],"sideEffects":["create request workflow item"],"notifications":["notify validation team"],"auditLog":"Marketing request submitted","tests":["submitted requests enter validation queue"]},
      {"key":"validate","label":"Validate request","from":["submitted"],"to":"validation","allowedRoles":["District Manager","SFE Manager","Super Admin"],"sideEffects":["update validation state"],"notifications":["notify request owner"],"auditLog":"Marketing request validated","tests":["validation action requires authorized role"]},
      {"key":"approve","label":"Approve request","from":["validation"],"to":"approved","allowedRoles":["SFE Manager","Super Admin"],"sideEffects":["mark request approved"],"notifications":["notify owner"],"auditLog":"Marketing request approved","tests":["approved requests are terminal"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'coaching_reports',
    'Coaching Reports',
    'Field coaching creation, manager submission, and employee acknowledgement workflow.',
    '[
      {"key":"draft","label":"Draft","terminal":false},
      {"key":"submitted","label":"Submitted","terminal":false},
      {"key":"acknowledged","label":"Acknowledged","terminal":true}
    ]'::jsonb,
    '[
      {"key":"submit","label":"Submit report","from":["draft"],"to":"submitted","allowedRoles":["Training Manager","Super Admin"],"sideEffects":["publish coaching report"],"notifications":["notify employee"],"auditLog":"Coaching report submitted","tests":["submitted coaching report becomes employee-visible"]},
      {"key":"acknowledge","label":"Employee acknowledge","from":["submitted"],"to":"acknowledged","allowedRoles":["Medical Rep","Employee"],"sideEffects":["record employee acknowledgement"],"notifications":["notify training manager"],"auditLog":"Coaching report acknowledged","tests":["acknowledgement records timestamp"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  )
on conflict (module_key) do update
set
  module_name = excluded.module_name,
  description = excluded.description,
  statuses = excluded.statuses,
  actions = excluded.actions,
  is_active = excluded.is_active,
  updated_by = 'system';
