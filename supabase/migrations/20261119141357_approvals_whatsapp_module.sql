-- approvals_whatsapp_module
--
-- WHAT THIS CHANGES: adds the Approvals WhatsApp store — the approvals line's chats, messages and
-- delivery ticks, its broadcast lists, its bulk sends with one row per recipient, and a private
-- bucket for its media. Six new tables, two functions, one trigger and one bucket. Nothing existing
-- is altered or read.
--
-- WHY: owner, 19 Nov 2026 — the approvals line (+20 10 40631155) becomes a WhatsApp-like screen on
-- the Super Admin's own admin side: chats with ticks, single and bulk sends, broadcast lists, read
-- reports and new wordings. His four answers that day: "Keep them, my screen only" (replies on that
-- number are KEPT — until now the webhook dropped them — and shown on his screen alone), "Super Admin
-- only", "Phoenix people + pasted", "Submit from the screen".
--
-- HARD ISOLATION FROM THE RECRUITMENT INBOX. These are separate tables, deliberately, not a line
-- filter on whatsapp_inbox_*: HR Resourcing reads that inbox, and a filter one query forgets would
-- show her the owner's approval conversations. Nothing here references a recruitment table.
--
--   approvals_whatsapp_conversations    one row per contact on the approvals line. Maintained ONLY by
--                                       the BEFORE INSERT trigger on messages, never by application
--                                       code, so the unread count and preview cannot drift.
--   approvals_whatsapp_messages         one row per message, either direction. wamid UNIQUE is the
--                                       idempotency (Meta retries). A failed send has no wamid and
--                                       still records (NULLs do not collide). delivered_at / read_at
--                                       / failed_at are stamped by the tick function, for the reports.
--   approvals_whatsapp_lists            a named broadcast list the owner keeps.
--   approvals_whatsapp_list_members     who is on it: an employee, or a pasted number.
--   approvals_whatsapp_broadcasts       one bulk send: the wording, its parameter mapping, totals.
--   approvals_whatsapp_broadcast_recipients
--                                       one row per recipient of a bulk send, written BEFORE anything
--                                       is sent, so a send stopped half way resumes from the rows
--                                       still 'pending' and never sends twice.
--   approvals-whatsapp-media            private bucket; a media id expires, the bytes do not.
--
-- WHY THE TRIGGER SKIPS A DUPLICATE ITSELF: a BEFORE INSERT trigger fires before the unique check, so
-- a retried delivery would bump unread_count and THEN be refused. It returns NULL for a known wamid.
-- (Copied from whatsapp_inbox_attach_conversation, 20260915200000, which has run since September.)
--
-- WHO CAN READ THIS: nobody but the service role. RLS on with a service_role policy; public, anon and
-- authenticated hold no privilege on any table or function. Every route in front of it admits the
-- Super Admin alone, checked server-side by role, never by a permission-matrix grant.
--
-- ROLLBACK: drop the six tables (messages, conversations, broadcast_recipients, broadcasts,
-- list_members, lists — in that order), the two functions, and the bucket's policy. The bucket itself
-- goes through the Storage API, never `delete from storage.objects`. Nothing else depends on them.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration only CREATES; nothing destructive or bulk runs.

begin;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('approvals-whatsapp-media', 'approvals-whatsapp-media', false, 104857600, null)
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists approvals_whatsapp_media_service_role on storage.objects';
    execute $policy$
      create policy approvals_whatsapp_media_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'approvals-whatsapp-media')
      with check (bucket_id = 'approvals-whatsapp-media')
    $policy$;
  end if;
end $$;

-- ── Broadcast lists ──

create table if not exists public.approvals_whatsapp_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  created_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approvals_whatsapp_lists_name_key unique (name)
);

comment on table public.approvals_whatsapp_lists is
  'A named broadcast list on the approvals WhatsApp line. Super Admin only, service role only.';

create table if not exists public.approvals_whatsapp_list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.approvals_whatsapp_lists (id) on delete cascade,
  -- Digits only, Meta's convention: 201xxxxxxxxx.
  wa_id text not null check (wa_id ~ '^[0-9]{8,15}$'),
  -- Set when the number came from an employee record; null for a pasted number. No FK on purpose:
  -- the person may leave, and the list must still say who was on it.
  employee_hr_id text,
  display_name text,
  added_by_hr_id text,
  added_at timestamptz not null default now(),
  constraint approvals_whatsapp_list_members_list_wa_key unique (list_id, wa_id)
);

comment on table public.approvals_whatsapp_list_members is
  'Who is on an approvals WhatsApp broadcast list: an employee (employee_hr_id set) or a pasted number. One number once per list.';

-- ── Bulk sends ──

create table if not exists public.approvals_whatsapp_broadcasts (
  id uuid primary key default gen_random_uuid(),
  template_name text not null,
  template_language text not null,
  -- The wording as the owner previewed it, with {{placeholders}} — what the report shows.
  body_preview text,
  -- How each template parameter is filled: a fixed text, or an employee field.
  parameter_mapping jsonb not null default '{}'::jsonb,
  list_id uuid references public.approvals_whatsapp_lists (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'done', 'stopped')),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  created_by_hr_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

comment on table public.approvals_whatsapp_broadcasts is
  'One bulk send on the approvals WhatsApp line. Its recipients are approvals_whatsapp_broadcast_recipients; read ticks come from approvals_whatsapp_messages by wamid.';

create table if not exists public.approvals_whatsapp_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.approvals_whatsapp_broadcasts (id) on delete cascade,
  wa_id text not null check (wa_id ~ '^[0-9]{8,15}$'),
  employee_hr_id text,
  display_name text,
  -- The parameter values this person's message was filled with, and the text they read.
  parameter_values jsonb not null default '{}'::jsonb,
  rendered_body text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'failed')),
  wamid text,
  failure_detail text,
  sent_at timestamptz,
  constraint approvals_whatsapp_broadcast_recipients_once unique (broadcast_id, wa_id),
  constraint approvals_whatsapp_broadcast_recipients_failed_has_detail check ((status = 'failed') = (failure_detail is not null))
);

comment on table public.approvals_whatsapp_broadcast_recipients is
  'One row per recipient of an approvals WhatsApp bulk send, written before any send. pending = not sent yet (a resume sends these); accepted = Meta took it (ticks on the message by wamid); failed = Meta refused it, with its reason.';

create index if not exists approvals_whatsapp_broadcasts_list_id_fk_idx
  on public.approvals_whatsapp_broadcasts (list_id);
create index if not exists approvals_whatsapp_broadcasts_recent_idx
  on public.approvals_whatsapp_broadcasts (created_at desc);
create index if not exists approvals_whatsapp_broadcast_recipients_pending_idx
  on public.approvals_whatsapp_broadcast_recipients (broadcast_id)
  where status = 'pending';
create index if not exists approvals_whatsapp_broadcast_recipients_wamid_idx
  on public.approvals_whatsapp_broadcast_recipients (wamid)
  where wamid is not null;

-- ── Chats ──

create table if not exists public.approvals_whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  phone_number_id text not null,
  -- Digits, or `user:<id>` for a username sender whose phone Meta did not share.
  contact_key text not null,
  contact_wa_id text,
  contact_user_id text,
  contact_name text,
  contact_username text,
  last_message_at timestamptz,
  -- The last LIVE message the contact sent: the 24-hour free-text window runs from this.
  last_inbound_at timestamptz,
  last_message_preview text,
  last_direction text check (last_direction is null or last_direction in ('inbound', 'outbound')),
  unread_count integer not null default 0 check (unread_count >= 0),
  -- The employee this number belongs to, matched by the app on the employee's mobile number. No FK:
  -- HR ids are mixed case, and a leaver's chat must survive them.
  employee_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approvals_whatsapp_conversations_line_contact_key unique (phone_number_id, contact_key)
);

comment on table public.approvals_whatsapp_conversations is
  'One row per contact on the approvals WhatsApp line. Maintained ONLY by the approvals_whatsapp_messages insert trigger (employee_hr_id excepted). Super Admin only.';

create table if not exists public.approvals_whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.approvals_whatsapp_conversations (id) on delete cascade,
  wamid text unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  -- contact = they wrote it; phoenix = any send through the Cloud API (a reminder, a single send from
  -- the screen, a bulk send); handset = a coexistence echo, should the number ever get an app.
  origin text not null check (origin in ('contact', 'phoenix', 'handset')),
  phone_number_id text not null,
  line_display_number text,
  contact_wa_id text,
  contact_user_id text,
  contact_name text,
  contact_username text,
  message_type text not null,
  body text,
  media_id text,
  media_mime_type text,
  media_file_name text,
  media_storage_path text,
  media_byte_size bigint check (media_byte_size is null or media_byte_size >= 0),
  media_fetched_at timestamptz,
  media_fetch_attempts integer not null default 0 check (media_fetch_attempts >= 0),
  media_fetch_error text,
  template_name text,
  reply_to_wamid text,
  payload jsonb,
  historical boolean not null default false,
  sent_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  status text not null check (status in ('received', 'accepted', 'sent', 'delivered', 'read', 'failed')),
  status_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  failure_detail text,
  event text,
  sent_by_hr_id text,
  broadcast_id uuid references public.approvals_whatsapp_broadcasts (id) on delete set null,
  constraint approvals_whatsapp_messages_has_contact check (contact_wa_id is not null or contact_user_id is not null),
  constraint approvals_whatsapp_messages_failed_has_reason check ((status = 'failed') = (failure_reason is not null)),
  constraint approvals_whatsapp_messages_fetched_has_path check ((media_fetched_at is null) = (media_storage_path is null))
);

comment on table public.approvals_whatsapp_messages is
  'Every WhatsApp message on the approvals line, in and out, from 2026-11-19 on: replies, reminders, single and bulk sends. wamid UNIQUE is the idempotency. Super Admin only.';

create index if not exists approvals_whatsapp_messages_thread_idx
  on public.approvals_whatsapp_messages (conversation_id, sent_at desc);
create index if not exists approvals_whatsapp_messages_broadcast_id_fk_idx
  on public.approvals_whatsapp_messages (broadcast_id);
-- The 250-contacts-a-day count reads recent Phoenix template sends.
create index if not exists approvals_whatsapp_messages_recent_templates_idx
  on public.approvals_whatsapp_messages (sent_at desc)
  where direction = 'outbound' and template_name is not null;
create index if not exists approvals_whatsapp_messages_media_pending_idx
  on public.approvals_whatsapp_messages (received_at)
  where media_id is not null and media_storage_path is null;
create index if not exists approvals_whatsapp_conversations_recent_idx
  on public.approvals_whatsapp_conversations (last_message_at desc nulls last);

create or replace function public.approvals_whatsapp_attach_conversation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_key text;
  v_id uuid;
  v_preview text;
  v_is_live_inbound boolean;
begin
  if new.wamid is not null
     and exists (select 1 from public.approvals_whatsapp_messages m where m.wamid = new.wamid) then
    return null;
  end if;

  v_key := coalesce(nullif(new.contact_wa_id, ''), 'user:' || nullif(new.contact_user_id, ''));
  if v_key is null then
    raise exception 'approvals_whatsapp_messages row has no contact';
  end if;

  v_preview := left(coalesce(
    nullif(new.body, ''),
    case new.message_type
      when 'image' then 'Photo'
      when 'video' then 'Video'
      when 'audio' then 'Voice note'
      when 'document' then coalesce(new.media_file_name, 'File')
      when 'sticker' then 'Sticker'
      when 'location' then 'Location'
      when 'contacts' then 'Contact card'
      when 'template' then 'Template message'
      else 'Message'
    end
  ), 240);
  v_is_live_inbound := new.direction = 'inbound' and not new.historical;

  insert into public.approvals_whatsapp_conversations as c (
    phone_number_id, contact_key, contact_wa_id, contact_user_id, contact_name, contact_username,
    last_message_at, last_inbound_at, last_message_preview, last_direction, unread_count
  )
  values (
    new.phone_number_id, v_key, new.contact_wa_id, new.contact_user_id, new.contact_name, new.contact_username,
    new.sent_at,
    case when v_is_live_inbound then new.sent_at end,
    v_preview,
    new.direction,
    case when v_is_live_inbound then 1 else 0 end
  )
  on conflict (phone_number_id, contact_key) do update
  set contact_wa_id = coalesce(excluded.contact_wa_id, c.contact_wa_id),
      contact_user_id = coalesce(excluded.contact_user_id, c.contact_user_id),
      contact_name = coalesce(excluded.contact_name, c.contact_name),
      contact_username = coalesce(excluded.contact_username, c.contact_username),
      last_message_preview = case
        when c.last_message_at is null or excluded.last_message_at >= c.last_message_at then excluded.last_message_preview
        else c.last_message_preview end,
      last_direction = case
        when c.last_message_at is null or excluded.last_message_at >= c.last_message_at then excluded.last_direction
        else c.last_direction end,
      last_message_at = greatest(c.last_message_at, excluded.last_message_at),
      last_inbound_at = greatest(c.last_inbound_at, excluded.last_inbound_at),
      unread_count = c.unread_count + excluded.unread_count,
      updated_at = now()
  returning c.id into v_id;

  new.conversation_id := v_id;
  return new;
end;
$$;

drop trigger if exists approvals_whatsapp_attach_conversation on public.approvals_whatsapp_messages;
create trigger approvals_whatsapp_attach_conversation
  before insert on public.approvals_whatsapp_messages
  for each row execute function public.approvals_whatsapp_attach_conversation();

-- Meta's ticks, FORWARD only: accepted < sent < delivered < read. `failed` may land at any point
-- before read, and nothing moves a failed message on. Stamps the moment each tick arrived, so the
-- report can say when a message was delivered and when it was read. Returns whether a row changed.
create or replace function public.approvals_whatsapp_apply_status(
  p_wamid text,
  p_status text,
  p_at timestamptz,
  p_failure_detail text default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_order text[] := array['accepted', 'sent', 'delivered', 'read'];
  v_changed integer;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    return false;
  end if;

  update public.approvals_whatsapp_messages m
  set status = p_status,
      status_at = p_at,
      -- A read tick can arrive without its delivered tick; a read message was delivered.
      delivered_at = case when p_status in ('delivered', 'read') then coalesce(m.delivered_at, p_at) else m.delivered_at end,
      read_at = case when p_status = 'read' then coalesce(m.read_at, p_at) else m.read_at end,
      failed_at = case when p_status = 'failed' then p_at else null end,
      failure_reason = case when p_status = 'failed' then 'failed' else null end,
      failure_detail = case when p_status = 'failed' then p_failure_detail else null end
  where m.wamid = p_wamid
    and m.direction = 'outbound'
    and (
      (p_status = 'failed' and m.status <> 'failed' and m.status <> 'read')
      or array_position(v_order, m.status) < array_position(v_order, p_status)
    );
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

-- The numbers Phoenix sent a TEMPLATE to on this line since p_since, failed sends excluded — the
-- unique contacts Meta's 250-a-day tier counts (a free-text reply inside a person's own 24-hour
-- window is not business-initiated and does not count).
create or replace function public.approvals_whatsapp_template_contacts_since(p_since timestamptz)
returns setof text
language sql
stable
set search_path = public
as $$
  select distinct m.contact_wa_id
  from public.approvals_whatsapp_messages m
  where m.direction = 'outbound'
    and m.template_name is not null
    and m.status <> 'failed'
    and m.sent_at >= p_since
    and m.contact_wa_id is not null;
$$;

alter table public.approvals_whatsapp_lists enable row level security;
alter table public.approvals_whatsapp_list_members enable row level security;
alter table public.approvals_whatsapp_broadcasts enable row level security;
alter table public.approvals_whatsapp_broadcast_recipients enable row level security;
alter table public.approvals_whatsapp_conversations enable row level security;
alter table public.approvals_whatsapp_messages enable row level security;

drop policy if exists phx_approvals_whatsapp_lists_service_role on public.approvals_whatsapp_lists;
create policy phx_approvals_whatsapp_lists_service_role on public.approvals_whatsapp_lists
  for all to service_role using (true) with check (true);
drop policy if exists phx_approvals_whatsapp_list_members_service_role on public.approvals_whatsapp_list_members;
create policy phx_approvals_whatsapp_list_members_service_role on public.approvals_whatsapp_list_members
  for all to service_role using (true) with check (true);
drop policy if exists phx_approvals_whatsapp_broadcasts_service_role on public.approvals_whatsapp_broadcasts;
create policy phx_approvals_whatsapp_broadcasts_service_role on public.approvals_whatsapp_broadcasts
  for all to service_role using (true) with check (true);
drop policy if exists phx_approvals_whatsapp_broadcast_recipients_service_role on public.approvals_whatsapp_broadcast_recipients;
create policy phx_approvals_whatsapp_broadcast_recipients_service_role on public.approvals_whatsapp_broadcast_recipients
  for all to service_role using (true) with check (true);
drop policy if exists phx_approvals_whatsapp_conversations_service_role on public.approvals_whatsapp_conversations;
create policy phx_approvals_whatsapp_conversations_service_role on public.approvals_whatsapp_conversations
  for all to service_role using (true) with check (true);
drop policy if exists phx_approvals_whatsapp_messages_service_role on public.approvals_whatsapp_messages;
create policy phx_approvals_whatsapp_messages_service_role on public.approvals_whatsapp_messages
  for all to service_role using (true) with check (true);

revoke all on table public.approvals_whatsapp_lists from public, anon, authenticated;
revoke all on table public.approvals_whatsapp_list_members from public, anon, authenticated;
revoke all on table public.approvals_whatsapp_broadcasts from public, anon, authenticated;
revoke all on table public.approvals_whatsapp_broadcast_recipients from public, anon, authenticated;
revoke all on table public.approvals_whatsapp_conversations from public, anon, authenticated;
revoke all on table public.approvals_whatsapp_messages from public, anon, authenticated;
grant all on table public.approvals_whatsapp_lists to service_role;
grant all on table public.approvals_whatsapp_list_members to service_role;
grant all on table public.approvals_whatsapp_broadcasts to service_role;
grant all on table public.approvals_whatsapp_broadcast_recipients to service_role;
grant all on table public.approvals_whatsapp_conversations to service_role;
grant all on table public.approvals_whatsapp_messages to service_role;

revoke all on function public.approvals_whatsapp_attach_conversation() from public, anon, authenticated;
revoke all on function public.approvals_whatsapp_apply_status(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.approvals_whatsapp_apply_status(text, text, timestamptz, text) to service_role;
revoke all on function public.approvals_whatsapp_template_contacts_since(timestamptz) from public, anon, authenticated;
grant execute on function public.approvals_whatsapp_template_contacts_since(timestamptz) to service_role;

commit;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected: six tables, rls_enabled = true, policies = 1 each,
-- anon/authenticated hold no privilege, bucket approvals-whatsapp-media public = false.
--
-- select c.relname, c.relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid) policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname like 'approvals_whatsapp_%' and c.relkind = 'r';
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name like 'approvals_whatsapp_%' and grantee in ('anon', 'authenticated');
-- select id, public from storage.buckets where id = 'approvals-whatsapp-media';
-- Timestamp 20261119141357 was minted to sort after every migration already on main.
