-- The WhatsApp INBOX: every message on both company lines, in and out, kept as a conversation.
--
-- Owner 2026-09-15: "can i open the whatsapp 2 accounts inside phoenix and be able to interact reply
-- save and send". Until now Phoenix kept no conversation at all. Inbound text sat in a 24-hour
-- buffer (ats_whatsapp_inbound_messages) and was then deleted; outbound was an audit log with no
-- inbound side; a voice note, a sticker, a location, a reaction or a message typed on the handset
-- itself was never written anywhere. So there was nothing a screen could show as a thread.
--
-- TWO TABLES AND A BUCKET.
--
--   whatsapp_inbox_messages       one row per message, either direction, either line. `wamid` is
--                                 Meta's own id and UNIQUE, which is the whole idempotency story:
--                                 Meta retries deliveries, and a coexistence replay can overlap a
--                                 live message. A FAILED send has no wamid, and a plain unique
--                                 constraint admits any number of NULLs, so those still record.
--   whatsapp_inbox_conversations  one row per (line, contact). Maintained by the BEFORE INSERT
--                                 trigger below, never by application code, so the unread count and
--                                 the last-message preview cannot drift from the messages under them.
--   whatsapp-inbox-media          private bucket. A media id is a claim with an expiry; the bytes
--                                 are what makes a photo still openable next month.
--
-- WHY THE TRIGGER SKIPS A DUPLICATE ITSELF. A BEFORE INSERT trigger fires before the unique check, so
-- a retried delivery would bump unread_count and THEN be refused. The trigger therefore returns NULL
-- (skip the row, silently) when the wamid already exists. Two concurrent copies of one message can
-- still both pass that read; the second then hits the unique constraint, its whole statement rolls
-- back — conversation bump included — and the application treats 23505 as "already recorded".
--
-- WHO CAN READ THIS. Nobody but the service role. Visibility is application-scoped in this codebase
-- (AGENTS.md §8), and the screen and every route in front of this table admit the Super Admin alone.
-- These are private conversations with members of the public and with employees.

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'whatsapp-inbox-media',
      'whatsapp-inbox-media',
      false,
      -- 100MB, WhatsApp's own ceiling for a document. No MIME allow-list: an inbox holds whatever a
      -- person sent — a photo, a PDF, a voice note, a sticker — and refusing a type here would only
      -- mean a message whose attachment silently cannot be opened.
      104857600,
      null
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists whatsapp_inbox_media_service_role on storage.objects';
    execute $policy$
      create policy whatsapp_inbox_media_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'whatsapp-inbox-media')
      with check (bucket_id = 'whatsapp-inbox-media')
    $policy$;
  end if;
end $$;

create table if not exists public.whatsapp_inbox_conversations (
  id uuid primary key default gen_random_uuid(),
  -- Which company line. A person who writes to both numbers is two conversations, deliberately: a
  -- reply must leave from the line they wrote to, or it opens a new chat from a number they do not
  -- recognise (whatsapp-conversation.ts, trap 1).
  phone_number_id text not null,
  -- The phone number (digits, Meta's convention) or `user:<BSUID>` for a username sender whose
  -- phone Meta did not share.
  contact_key text not null,
  contact_wa_id text,
  contact_user_id text,
  -- The person's own WhatsApp profile name. A hint, never an identity.
  contact_name text,
  contact_username text,
  last_message_at timestamptz,
  -- The last LIVE message they sent. The 24-hour free-text window runs from this, and a history
  -- replay never opens a window, so replays do not move it.
  last_inbound_at timestamptz,
  last_message_preview text,
  last_direction text check (last_direction is null or last_direction in ('inbound', 'outbound')),
  unread_count integer not null default 0 check (unread_count >= 0),
  -- Linked by a human, never guessed: a shared phone is not the same person (MEMORY: contact review).
  candidate_id uuid references public.ats_candidates (id) on delete set null,
  -- No FK on purpose: HR ids are mixed case in this database and a case-sensitive FK would refuse
  -- real employees.
  employee_hr_id text,
  linked_by_hr_id text,
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_inbox_conversations_line_contact_key unique (phone_number_id, contact_key)
);

comment on table public.whatsapp_inbox_conversations is
  'One row per (company WhatsApp line, contact). Maintained ONLY by the whatsapp_inbox_messages insert trigger; candidate_id / employee_hr_id are set by a human from the WhatsApp Inbox screen. Super Admin only.';

create table if not exists public.whatsapp_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  -- Filled by the trigger. Nullable only so the trigger can fill it.
  conversation_id uuid references public.whatsapp_inbox_conversations (id) on delete cascade,
  wamid text unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  -- Who produced it: the contact, Phoenix (any send through the Cloud API — automated or a human in
  -- the inbox), or the HR handset's own WhatsApp Business app (coexistence echo / history replay).
  origin text not null check (origin in ('contact', 'phoenix', 'handset')),
  phone_number_id text not null,
  line_display_number text,
  contact_wa_id text,
  contact_user_id text,
  contact_name text,
  contact_username text,
  message_type text not null,
  -- What a person reads: the text, a caption, a rendered template, or a plain description of a
  -- structure ("Shared a location: ...").
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
  -- The message this one answers or reacts to.
  reply_to_wamid text,
  payload jsonb,
  historical boolean not null default false,
  -- When it was SENT (Meta's timestamp for inbound), not when this row was written.
  sent_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  status text not null check (status in ('received', 'accepted', 'sent', 'delivered', 'read', 'failed')),
  status_at timestamptz,
  failure_reason text,
  failure_detail text,
  -- The event name the send was recorded under (whatsapp_inbox_send, whatsapp_classify_menu_send ...).
  event text,
  sent_by_hr_id text,
  saved_to_candidate_id uuid references public.ats_candidates (id) on delete set null,
  saved_file_id uuid,
  saved_at timestamptz,
  saved_by_hr_id text,
  constraint whatsapp_inbox_messages_has_contact check (contact_wa_id is not null or contact_user_id is not null),
  constraint whatsapp_inbox_messages_failed_has_reason check ((status = 'failed') = (failure_reason is not null)),
  constraint whatsapp_inbox_messages_fetched_has_path check ((media_fetched_at is null) = (media_storage_path is null))
);

comment on table public.whatsapp_inbox_messages is
  'Every WhatsApp message on both company lines, in and out, from 2026-09-15 on. wamid UNIQUE is the idempotency. media_storage_path filled = the bytes are safe in whatsapp-inbox-media. Super Admin only.';

create index if not exists whatsapp_inbox_messages_thread_idx
  on public.whatsapp_inbox_messages (conversation_id, sent_at desc);

-- The media cache worker: attachments not yet copied, oldest first.
create index if not exists whatsapp_inbox_messages_media_pending_idx
  on public.whatsapp_inbox_messages (received_at)
  where media_id is not null and media_storage_path is null;

create index if not exists whatsapp_inbox_conversations_recent_idx
  on public.whatsapp_inbox_conversations (last_message_at desc nulls last);

create or replace function public.whatsapp_inbox_attach_conversation()
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
     and exists (select 1 from public.whatsapp_inbox_messages m where m.wamid = new.wamid) then
    -- Already recorded (a Meta retry, or a replay overlapping a live message). Skip the row, and
    -- with it the unread bump — see the header.
    return null;
  end if;

  v_key := coalesce(nullif(new.contact_wa_id, ''), 'user:' || nullif(new.contact_user_id, ''));
  if v_key is null then
    raise exception 'whatsapp_inbox_messages row has no contact';
  end if;

  -- The chat list shows words, never a message-type code.
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

  insert into public.whatsapp_inbox_conversations as c (
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
      -- Only the contact's own messages carry their profile name; an outbound row must not blank it.
      contact_name = coalesce(excluded.contact_name, c.contact_name),
      contact_username = coalesce(excluded.contact_username, c.contact_username),
      last_message_preview = case
        when c.last_message_at is null or excluded.last_message_at >= c.last_message_at then excluded.last_message_preview
        else c.last_message_preview end,
      last_direction = case
        when c.last_message_at is null or excluded.last_message_at >= c.last_message_at then excluded.last_direction
        else c.last_direction end,
      -- greatest() ignores NULLs, so an outbound row never clears the inbound clock.
      last_message_at = greatest(c.last_message_at, excluded.last_message_at),
      last_inbound_at = greatest(c.last_inbound_at, excluded.last_inbound_at),
      unread_count = c.unread_count + excluded.unread_count,
      updated_at = now()
  returning c.id into v_id;

  new.conversation_id := v_id;
  return new;
end;
$$;

drop trigger if exists whatsapp_inbox_attach_conversation on public.whatsapp_inbox_messages;
create trigger whatsapp_inbox_attach_conversation
  before insert on public.whatsapp_inbox_messages
  for each row execute function public.whatsapp_inbox_attach_conversation();

-- Meta's delivery ticks, applied FORWARD only: accepted < sent < delivered < read. `failed` may land
-- at any point, and nothing moves a failed message on (array_position of 'failed' is NULL, so the
-- comparison is never true). Returns whether a row changed.
create or replace function public.whatsapp_inbox_apply_status(
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

  update public.whatsapp_inbox_messages m
  set status = p_status,
      status_at = p_at,
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

alter table public.whatsapp_inbox_conversations enable row level security;
alter table public.whatsapp_inbox_messages enable row level security;

drop policy if exists phx_whatsapp_inbox_conversations_service_role on public.whatsapp_inbox_conversations;
create policy phx_whatsapp_inbox_conversations_service_role on public.whatsapp_inbox_conversations
  for all to service_role using (true) with check (true);

drop policy if exists phx_whatsapp_inbox_messages_service_role on public.whatsapp_inbox_messages;
create policy phx_whatsapp_inbox_messages_service_role on public.whatsapp_inbox_messages
  for all to service_role using (true) with check (true);

revoke all on table public.whatsapp_inbox_conversations from public, anon, authenticated;
revoke all on table public.whatsapp_inbox_messages from public, anon, authenticated;
grant all on table public.whatsapp_inbox_conversations to service_role;
grant all on table public.whatsapp_inbox_messages to service_role;

revoke all on function public.whatsapp_inbox_apply_status(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.whatsapp_inbox_apply_status(text, text, timestamptz, text) to service_role;
revoke all on function public.whatsapp_inbox_attach_conversation() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected:
--   both tables rls_enabled = true, policies = 1, anon/authenticated hold no privilege
--   bucket whatsapp-inbox-media public = false
--   rows = 0 until the first webhook delivery after deploy

-- select c.relname, c.relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid) policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname like 'whatsapp_inbox_%' and c.relkind = 'r';
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name like 'whatsapp_inbox_%' and grantee in ('anon', 'authenticated');
-- select id, public from storage.buckets where id = 'whatsapp-inbox-media';
