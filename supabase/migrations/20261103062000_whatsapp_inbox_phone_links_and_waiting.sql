-- whatsapp_inbox_phone_links_and_waiting
--
-- Two functions for the WhatsApp Inbox. Neither changes a table's shape, and creating them changes no
-- row: the links are written only when the inbound-intake cron calls the first function.
--
-- whatsapp_inbox_link_chats_by_phone links a chat to a candidate when the number leaves one answer:
-- exactly one candidate holds it (phone_norm, the same canonical form Meta's wa_id arrives in), no
-- employee holds it, and the number never sent a CV that became somebody else (a forwarder). A person's
-- own decision is never overwritten: a chat a person linked or unlinked carries that person in
-- linked_by_hr_id and is skipped. linked_by_hr_id NULL is a link nobody chose, including the 622 chats
-- whose candidate was deleted on 18 Oct 2026 (the foreign key cleared candidate_id and left linked_at).
--
-- whatsapp_inbox_waiting_chats answers who is waiting for a reply: a real message from the contact
-- with no successful reply after it, from a read of the messages themselves, so a send that failed
-- later stops counting as a reply. A reaction, a deleted message and a system notice are not a message
-- anyone is waiting on. Read on every inbox refresh, so it is bounded by last_inbound_at first.

create or replace function public.whatsapp_inbox_link_chats_by_phone(p_limit integer default 500)
returns table (conversation_id uuid, candidate_id uuid)
language sql
set search_path = public
set statement_timeout = '30s'
as $$
  with only_holder as (
    select a.phone_norm, (array_agg(a.id))[1] as candidate_id
    from public.ats_candidates a
    where a.phone_norm is not null
    group by a.phone_norm
    having count(*) = 1
  ),
  eligible as (
    select c.id, h.candidate_id
    from public.whatsapp_inbox_conversations c
    join only_holder h on h.phone_norm = c.contact_wa_id
    where c.candidate_id is null
      and c.employee_hr_id is null
      and (c.linked_by_hr_id is null or c.linked_by_hr_id = 'phone-match')
      and not exists (
        select 1 from public.employees e
        where right(regexp_replace(coalesce(e.mobile_number::text, ''), '\D', '', 'g'), 10) = right(c.contact_wa_id, 10)
      )
      and not exists (
        select 1 from public.ats_cv_intake_events i
        where i.sender_identifier = '+' || c.contact_wa_id
          and i.candidate_id is not null
          and i.candidate_id <> h.candidate_id
      )
    order by c.last_message_at desc nulls last
    limit greatest(1, least(coalesce(p_limit, 500), 1000))
  )
  update public.whatsapp_inbox_conversations c
  set candidate_id = e.candidate_id,
      linked_at = now(),
      linked_by_hr_id = 'phone-match',
      updated_at = now()
  from eligible e
  where c.id = e.id
  returning c.id, c.candidate_id;
$$;

comment on function public.whatsapp_inbox_link_chats_by_phone(integer) is
  'Links a WhatsApp Inbox chat to the one candidate its number can only mean. Never touches a chat a person linked or unlinked. Called by the inbound-intake cron.';

revoke execute on function public.whatsapp_inbox_link_chats_by_phone(integer) from public, anon, authenticated;
grant execute on function public.whatsapp_inbox_link_chats_by_phone(integer) to service_role;

create or replace function public.whatsapp_inbox_waiting_chats(p_since timestamptz)
returns table (
  conversation_id uuid,
  waiting_since timestamptz,
  phone_number_id text,
  candidate_id uuid,
  contact_wa_id text
)
language sql
stable
set search_path = public
set statement_timeout = '10s'
as $$
  select c.id, w.first_at, c.phone_number_id, c.candidate_id, c.contact_wa_id
  from public.whatsapp_inbox_conversations c
  cross join lateral (
    select min(m.sent_at) as first_at, max(m.sent_at) as newest_at
    from public.whatsapp_inbox_messages m
    where m.conversation_id = c.id
      and m.direction = 'inbound'
      and not m.historical
      and m.message_type not in ('reaction', 'revoke', 'system')
      and m.sent_at > coalesce(
        (
          select max(o.sent_at)
          from public.whatsapp_inbox_messages o
          where o.conversation_id = c.id
            and o.direction = 'outbound'
            and o.status <> 'failed'
        ),
        '-infinity'::timestamptz
      )
  ) w
  where c.last_inbound_at >= p_since
    and w.newest_at >= p_since;
$$;

comment on function public.whatsapp_inbox_waiting_chats(timestamptz) is
  'The WhatsApp Inbox chats waiting for a reply since p_since: a real message from the contact with no successful reply after it. waiting_since is the oldest such message.';

revoke execute on function public.whatsapp_inbox_waiting_chats(timestamptz) from public, anon, authenticated;
grant execute on function public.whatsapp_inbox_waiting_chats(timestamptz) to service_role;

comment on table public.whatsapp_inbox_conversations is
  'One row per (company WhatsApp line, contact). Maintained ONLY by the whatsapp_inbox_messages insert trigger; candidate_id / employee_hr_id are set by a person from the WhatsApp Inbox screen, or by whatsapp_inbox_link_chats_by_phone (linked_by_hr_id = ''phone-match'') when the number can only mean one candidate.';
