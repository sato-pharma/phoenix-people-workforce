-- approval_whatsapp_reminders
--
-- WHAT THIS CHANGES: one new table. Nothing existing is touched.
--
-- WHY IT EXISTS (owner, 3 Nov 2026: all 25 approvers, on a new third number). Once a working day each approver holding
-- something for more than three days gets one WhatsApp message with a count (src/lib/approvals/urgent-whatsapp.ts).
-- This is the record of each one, and the guard: the row is claimed BEFORE the send on a unique person and Cairo day, so
-- two ticks cannot both message someone and a run that dies mid-send never messages them twice that day.
--
-- `counts` holds counts by chain and nothing else, no names and no request ids. A person with no readable number is a
-- `no_number` row, never a silent skip. RLS on with no policies: only the service role reads or writes this.
--
-- ROLLBACK: drop table public.approval_whatsapp_reminders;

begin;

create table public.approval_whatsapp_reminders (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  cairo_day date not null,
  to_wa_id text,
  phone_number_id text not null,
  counts jsonb not null,
  total integer not null check (total > 0),
  status text not null check (status in ('claimed', 'no_number', 'accepted', 'delivered', 'read', 'failed')),
  wamid text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approval_whatsapp_reminders_one_a_day unique (hr_id, cairo_day)
);

-- Meta's delivery ticks find their row by message id.
create index approval_whatsapp_reminders_wamid_idx on public.approval_whatsapp_reminders (wamid) where wamid is not null;

alter table public.approval_whatsapp_reminders enable row level security;

revoke all on table public.approval_whatsapp_reminders from public, anon, authenticated;
grant all on table public.approval_whatsapp_reminders to service_role;

notify pgrst, 'reload schema';

commit;
