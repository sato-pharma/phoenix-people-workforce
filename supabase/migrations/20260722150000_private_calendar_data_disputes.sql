-- Private Calendar — data accuracy disputes.
--
-- An employee can flag that what the Private Calendar shows for a specific day
-- (or a specific item within that day) is wrong, and must state what actually
-- happened plus where a Super Admin can verify it. Super Admin reviews and
-- either Accepts (the calendar shows the verified correction as an annotation
-- ON TOP of the original synced item — the original source data, e.g. a CRM
-- visit row or a fingerprint punch, is never mutated by this table; Phoenix
-- does not own that upstream data) or Rejects (nothing changes, employee is
-- told why).
--
-- Tables (all RLS-enabled with NO policies -> service-role-only; the browser
-- never reads these directly, the server uses getSupabaseAdmin()):

begin;

create table if not exists public.private_calendar_data_disputes (
    id uuid primary key default gen_random_uuid(),
    employee_hr_id text not null,
    employee_name text,
    dispute_date date not null,
    -- Which private-calendar item this targets, if the employee is disputing one
    -- specific item rather than the whole day (e.g. one of several DV entries on
    -- a day with multiple visits). Null means the dispute is about the whole day.
    item_source text,
    item_source_record_id text,
    -- Snapshot of what the calendar actually showed at submission time, so the
    -- audit trail is self-contained even if the underlying source data changes
    -- or the item later disappears from a re-sync.
    displayed_summary text not null,
    claim_text text not null,
    claim_source_text text not null,
    status text not null default 'pending_review',
    admin_hr_id text,
    admin_decision_note text,
    decided_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint private_calendar_data_disputes_status_check
        check (status in ('pending_review', 'accepted', 'rejected')),
    constraint private_calendar_data_disputes_item_source_check
        check (item_source is null or item_source in ('attendance', 'double_visit', 'excuse', 'holiday', 'plan', 'vacation')),
    constraint private_calendar_data_disputes_claim_text_check check (length(trim(claim_text)) > 0),
    constraint private_calendar_data_disputes_claim_source_check check (length(trim(claim_source_text)) > 0),
    constraint private_calendar_data_disputes_decided_fields_check
        check (
            (status = 'pending_review' and admin_hr_id is null and decided_at is null)
            or (status <> 'pending_review' and admin_hr_id is not null and decided_at is not null)
        )
);

comment on table public.private_calendar_data_disputes is
    'Employee-flagged private-calendar data accuracy disputes. Governance/audit only — never mutates the original synced source record (CRM/fingerprint/etc); an accepted dispute is displayed as a verified-correction annotation layered on top of the original item.';

-- One open dispute per employee/day/item at a time — resubmission must wait
-- for the existing one to be decided, so the review queue can't be spammed.
create unique index if not exists private_calendar_data_disputes_pending_uidx
    on public.private_calendar_data_disputes (employee_hr_id, dispute_date, coalesce(item_source, ''), coalesce(item_source_record_id, ''))
    where status = 'pending_review';

create index if not exists private_calendar_data_disputes_employee_date_idx
    on public.private_calendar_data_disputes (employee_hr_id, dispute_date);

create index if not exists private_calendar_data_disputes_status_idx
    on public.private_calendar_data_disputes (status)
    where status = 'pending_review';

alter table public.private_calendar_data_disputes enable row level security;

-- ── Workflow registry: governance visibility only (decisions are still the
-- hand-rolled compare-and-swap in the service layer, matching the codebase's
-- convention for small 2-3 status flows — this row just gives Super Admin the
-- same /admin/workflow-registry visibility every other module gets). ────────
insert into public.workflow_registry_modules (
    module_key, module_name, description, statuses, actions, is_active, created_by, updated_by
)
values (
    'private_calendar_data_disputes',
    'Private Calendar Data Disputes',
    'Employee-flagged private-calendar data accuracy disputes, reviewed and decided by Super Admin.',
    '[
        {"key":"pending_review","label":"Pending Review","terminal":false},
        {"key":"accepted","label":"Accepted","terminal":true},
        {"key":"rejected","label":"Rejected","terminal":true}
    ]'::jsonb,
    '[
        {"key":"submit","label":"Employee flags inaccurate data","from":[],"to":"pending_review","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Financial Advisor","Talent Acquisition","Manager","CEO","Super Admin"],"requiresReason":true,"sideEffects":["notify Super Admin"],"notifications":["notify Super Admin the dispute needs review"],"auditLog":"Private calendar data dispute submitted","tests":["private calendar dispute submit is service-gated"]},
        {"key":"accept","label":"Super Admin accepts the dispute","from":["pending_review"],"to":"accepted","allowedRoles":["Super Admin"],"requiresReason":true,"sideEffects":["record verified correction annotation","notify employee"],"notifications":["notify employee the dispute was accepted"],"auditLog":"Private calendar data dispute accepted","tests":["private calendar dispute accept is Super Admin only"]},
        {"key":"reject","label":"Super Admin rejects the dispute","from":["pending_review"],"to":"rejected","allowedRoles":["Super Admin"],"requiresReason":true,"sideEffects":["notify employee"],"notifications":["notify employee the dispute was rejected"],"auditLog":"Private calendar data dispute rejected","tests":["private calendar dispute reject is Super Admin only"]}
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
