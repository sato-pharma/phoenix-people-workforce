-- Mailbox compliance monitor — the owner, as domain administrator and compliance officer, holds
-- an app password for a company @satopharma.com mailbox and lets Phoenix read it over IMAP the
-- same way careers@/hr@ are already read: strictly read-only, never touching the \Seen flag, so the
-- employee sees nothing. This migration stores the monitored mailboxes and an access log.
--
-- Safety by design:
--   * The app password is NEVER stored in plaintext. `sealed_password` holds an AES-256-GCM blob
--     from src/lib/security/secret-box.ts, sealed with a server-only env secret that is not in this
--     repo and not in any row. A DB read alone cannot recover a mailbox password.
--   * Both tables are service-role only (RLS enabled, no policies) — never exposed to any browser
--     role. Access is gated in the route layer by the Super-Admin-only `mailbox_monitor` permission.
--   * Every open of a mailbox or a message writes an access-log row: the compliance tool is itself
--     audited, so there is always a record of who read whose mail and when.
--   * status + last_error let Phoenix surface the moment a credential stops working (an employee
--     who revokes the app password or changes their login password), rather than failing silently.

begin;

create table if not exists public.mailbox_monitors (
  id uuid primary key default gen_random_uuid(),
  -- The mailbox under monitoring. Unique so the same address cannot be added twice.
  email_address text not null unique,
  -- Optional link to the employee who owns the mailbox, and a human label for the list view.
  employee_hr_id text,
  display_label text check (display_label is null or char_length(display_label) <= 200),
  -- IMAP connection. Defaults match Turbify/Yahoo business mail (imap.mail.yahoo.com:993, TLS).
  imap_host text not null,
  imap_port integer not null default 993 check (imap_port between 1 and 65535),
  imap_secure boolean not null default true,
  -- The app password, sealed by secret-box.ts. Never plaintext.
  sealed_password text not null,
  -- Lifecycle: active (readable), failing (last connect errored — credential likely revoked),
  -- disabled (owner paused it), revoked (owner removed the credential but kept the row for history).
  status text not null default 'active' check (status in ('active', 'failing', 'disabled', 'revoked')),
  last_ok_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mailbox_monitors_status on public.mailbox_monitors (status);
create index if not exists idx_mailbox_monitors_employee on public.mailbox_monitors (employee_hr_id);

-- Who read what, and when. Append-only in practice (no update/delete path in the service).
create table if not exists public.mailbox_monitor_access_log (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid references public.mailbox_monitors (id) on delete set null,
  email_address text,
  actor_hr_id text,
  -- add | delete | connect_test | list_folders | list_messages | open_message | update
  action text not null,
  folder text,
  message_uid text,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_mmal_monitor on public.mailbox_monitor_access_log (monitor_id, created_at desc);
create index if not exists idx_mmal_actor on public.mailbox_monitor_access_log (actor_hr_id, created_at desc);

alter table public.mailbox_monitors enable row level security;
alter table public.mailbox_monitor_access_log enable row level security;

notify pgrst, 'reload schema';

commit;
