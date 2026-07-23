-- Notification Confidence Gate — every automated email now passes through
-- src/lib/notifications/confidence-gate.ts (called from send-phoenix-email.ts,
-- the single choke point every automated email goes through) before it is
-- actually dispatched to the provider. This table is both the durable audit
-- log of every attempt (checks run, confidence score, decision) AND the
-- pending-review queue a Super Admin works from at /admin/notification-confidence.
--
-- status:
--   'auto_sent' — passed the gate, delivered normally
--   'held'      — failed the gate, NOT delivered, awaiting a Super Admin decision
--   'approved'  — was held, a Super Admin approved it, then delivered
--   'discarded' — was held, a Super Admin discarded it, never delivered

begin;

create table if not exists public.notification_send_reviews (
    id uuid primary key default gen_random_uuid(),
    idempotency_key text not null,
    module text,
    event_type text,
    notification_type text,
    template_key text,
    recipient_hr_id text,
    employee_hr_id text,
    to_addresses text[] not null default '{}',
    cc_addresses text[] not null default '{}',
    bcc_addresses text[] not null default '{}',
    subject text not null,
    rendered_html text not null,
    rendered_text text not null,
    checks jsonb not null default '[]'::jsonb,
    confidence_percent integer not null,
    decision text not null check (decision in ('auto_send', 'hold')),
    status text not null default 'held' check (status in ('auto_sent', 'held', 'approved', 'discarded')),
    gate_bypassed boolean not null default false,
    provider_message_id text,
    decided_by text,
    decided_at timestamptz,
    decision_note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table public.notification_send_reviews is
    'Audit log + pending-review queue for the Notification Confidence Gate. Every automated email (all modules) is recorded here before dispatch.';
comment on column public.notification_send_reviews.checks is
    'Array of {name, passed, detail} — every validator run for this send and its result.';
comment on column public.notification_send_reviews.status is
    'auto_sent (passed, delivered) / held (failed, not delivered, awaiting review) / approved (was held, admin approved, delivered) / discarded (was held, admin discarded, never delivered).';

create index if not exists notification_send_reviews_module_event_created_idx
    on public.notification_send_reviews (module, event_type, created_at desc);
create index if not exists notification_send_reviews_status_created_idx
    on public.notification_send_reviews (status, created_at desc);
create index if not exists notification_send_reviews_idempotency_key_idx
    on public.notification_send_reviews (idempotency_key);

alter table public.notification_send_reviews enable row level security;
-- No policies: service-role only (this table is written/read exclusively from server-side
-- code — send-phoenix-email.ts and the admin API routes), matching the RLS convention used
-- for every other server-only table added this cycle (private_calendar_data_disputes, etc.).

notify pgrst, 'reload schema';

commit;
