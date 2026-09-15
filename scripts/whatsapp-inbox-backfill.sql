-- WhatsApp Inbox — backfill the chats that happened before the inbox existed.
--
-- The owner asked on 2026-09-15 to "backfill my chats". The inbox only records what arrives after
-- its webhook code ships, so every conversation from before then is rebuilt here from the tables
-- that were already keeping pieces of it:
--
--   ats_cv_intake_events (channel whatsapp)  what applicants SENT: CVs, photos, texts
--   ats_whatsapp_outbound_messages           what Phoenix SENT by itself: menus, questions, thanks
--   whatsapp_inbound_video                   the HR handset's FTP videos
--   whatsapp_inbound_submission_id           the HR handset's FTP submission-ID messages
--
-- Every row carries its real WhatsApp message id, and the inbox's `wamid` is unique with an insert
-- trigger that skips a message it already holds — so this script can be run again, and a message
-- the live webhook records later is never doubled.
--
--   ats_whatsapp_classification_sessions  what applicants ANSWERED to those questions (rebuilt, below)
--
-- NOT backfilled, because no real message exists for them:
--   ats_whatsapp_template_sends   a rendered template opened on a phone (wa.me), not a proof it was sent
--   ats_whatsapp_inbound_messages a 24-hour text buffer with no message ids; its texts are in intake
--
-- How it is marked: `payload = {"backfill": <source table>, "sourceId": <row id>}`. To undo:
--   delete from public.whatsapp_inbox_messages where payload ? 'backfill';
--   delete from public.whatsapp_inbox_conversations c
--    where not exists (select 1 from public.whatsapp_inbox_messages m where m.conversation_id = c.id);
--
-- Unread and the reply window: rows go in as ordinary (not `historical`) messages so the trigger
-- records each chat's true last inbound time — the 24-hour reply window is then exactly right. The
-- trigger also counts every backfilled inbound message as unread; the script subtracts precisely the
-- inbound rows IT inserted, so nothing old shows as unread and a live unread count is never touched.
--
-- Chats are linked to a candidate only when every CV in that chat reached the SAME candidate. A chat
-- whose CVs went to several candidates (a forwarder) stays unlinked.

begin;

create temp table inbox_backfill (
  src text not null,
  source_id text not null,
  wamid text not null,
  direction text not null,
  origin text not null,
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
  media_byte_size bigint,
  historical boolean not null,
  sent_at timestamptz not null,
  received_at timestamptz not null,
  status text not null,
  event text,
  saved_to_candidate_id uuid,
  saved_file_id uuid,
  candidate_id uuid
) on commit drop;

-- ── What applicants sent ─────────────────────────────────────────────────────────────────────────
-- Rows from before the handset joined (2026-09-11) predate line recording; the recruitment line was
-- then the only number on the platform.
insert into inbox_backfill
select
  'ats_cv_intake_events',
  e.id::text,
  e.provider_message_id,
  'inbound',
  'contact',
  coalesce(e.raw_metadata->>'deliveredToPhoneNumberId', '1319071451278873'),
  coalesce(e.raw_metadata->>'deliveredToDisplayNumber', '201098500699'),
  nullif(e.raw_metadata->>'wa_id', ''),
  nullif(e.raw_metadata->>'userId', ''),
  nullif(btrim(e.sender_display_name), ''),
  null,
  coalesce(e.raw_metadata->>'messageType', 'text'),
  case
    when coalesce(e.raw_metadata->>'messageType', 'text') = 'text'
      then coalesce(nullif(btrim(e.raw_metadata->>'body'), ''), 'Message text was not kept.')
    when nullif(btrim(e.raw_metadata#>>'{sourceContext,caption}'), '') is not null
         and btrim(e.raw_metadata#>>'{sourceContext,caption}') is distinct from f.file_name
      then btrim(e.raw_metadata#>>'{sourceContext,caption}')
    when f.id is null and e.raw_metadata->>'messageType' = 'image'
      then 'Photo — Phoenix did not keep a copy.'
    when f.id is null
      then 'File — Phoenix did not keep a copy.'
    else null
  end,
  null,
  f.mime_type,
  f.file_name,
  f.size_bytes,
  false,
  e.created_at,
  e.created_at,
  'received',
  'whatsapp_inbox_backfill',
  fc.id,
  f.id,
  ec.id
from public.ats_cv_intake_events e
left join public.ats_files f on f.id = e.file_id
left join public.ats_candidates fc on fc.id = f.candidate_id
left join public.ats_candidates ec on ec.id = e.candidate_id
where e.channel = 'whatsapp'
  and e.provider_message_id is not null
  and (nullif(e.raw_metadata->>'wa_id', '') is not null or nullif(e.raw_metadata->>'userId', '') is not null);

-- ── The HR handset's FTP videos ──────────────────────────────────────────────────────────────────
insert into inbox_backfill
select
  'whatsapp_inbound_video', v.id::text, v.wamid, 'inbound', 'contact',
  v.delivered_to_phone_number_id, v.delivered_to_display_number,
  nullif(v.wa_id, ''), nullif(v.user_id, ''), nullif(btrim(v.contact_name), ''), nullif(v.username, ''),
  'video', nullif(btrim(v.caption), ''),
  v.media_id, v.mime_type, v.file_name, v.byte_size,
  coalesce(v.historical, false), v.sent_at, v.received_at, 'received', 'whatsapp_inbox_backfill',
  null, null, null
from public.whatsapp_inbound_video v
where v.wamid is not null and v.delivered_to_phone_number_id is not null
  and (nullif(v.wa_id, '') is not null or nullif(v.user_id, '') is not null);

-- ── The HR handset's FTP submission-ID messages ──────────────────────────────────────────────────
-- The table keeps the IDs read out of the message, not its wording; the IDs are what it said.
insert into inbox_backfill
select
  'whatsapp_inbound_submission_id', s.id::text, s.wamid, 'inbound', 'contact',
  s.delivered_to_phone_number_id, s.delivered_to_display_number,
  nullif(s.wa_id, ''), nullif(s.user_id, ''), nullif(btrim(s.contact_name), ''), nullif(s.username, ''),
  'text', array_to_string(s.submission_ids, ', '),
  null, null, null, null,
  coalesce(s.historical, false), s.sent_at, s.received_at, 'received', 'whatsapp_inbox_backfill',
  null, null, null
from public.whatsapp_inbound_submission_id s
where s.wamid is not null and s.delivered_to_phone_number_id is not null
  and (nullif(s.wa_id, '') is not null or nullif(s.user_id, '') is not null);

-- ── What Phoenix sent by itself ──────────────────────────────────────────────────────────────────
-- Only accepted sends were ever logged. A menu keeps no body column; its words and choices are in
-- the payload that was sent.
insert into inbox_backfill
select
  'ats_whatsapp_outbound_messages', o.id::text, o.provider_message_id, 'outbound', 'phoenix',
  o.phone_number_id,
  case o.phone_number_id when '1319071451278873' then '201098500699' when '477586495433549' then '201159888247' end,
  nullif(o.to_wa_id, ''), null, null, null,
  o.message_type,
  coalesce(
    nullif(btrim(o.body), ''),
    nullif(concat_ws(
      E'\n',
      nullif(btrim(o.payload#>>'{interactive,body,text}'), ''),
      (select 'Choices: ' || string_agg(row_item->>'title', ' · ')
         from jsonb_array_elements(coalesce(o.payload#>'{interactive,action,sections}', '[]'::jsonb)) sec,
              jsonb_array_elements(coalesce(sec->'rows', '[]'::jsonb)) row_item),
      (select 'Choices: ' || string_agg(btn#>>'{reply,title}', ' · ')
         from jsonb_array_elements(coalesce(o.payload#>'{interactive,action,buttons}', '[]'::jsonb)) btn)
    ), '')
  ),
  null, null, null, null,
  false, o.created_at, o.created_at,
  case when o.ok then 'sent' else 'failed' end,
  o.event,
  null, null, null
from public.ats_whatsapp_outbound_messages o
where o.provider_message_id is not null and nullif(o.to_wa_id, '') is not null and o.phone_number_id is not null;

create temp table inbox_backfill_inserted (conversation_id uuid, direction text, historical boolean) on commit drop;

with inserted as (
  insert into public.whatsapp_inbox_messages (
    wamid, direction, origin, phone_number_id, line_display_number, contact_wa_id, contact_user_id,
    contact_name, contact_username, message_type, body, media_id, media_mime_type, media_file_name,
    media_byte_size, payload, historical, sent_at, received_at, status, status_at, failure_reason,
    event, saved_to_candidate_id, saved_file_id, saved_at
  )
  select
    b.wamid, b.direction, b.origin, b.phone_number_id, b.line_display_number, b.contact_wa_id, b.contact_user_id,
    b.contact_name, b.contact_username, b.message_type, b.body, b.media_id, b.media_mime_type, b.media_file_name,
    b.media_byte_size, jsonb_build_object('backfill', b.src, 'sourceId', b.source_id), b.historical,
    b.sent_at, b.received_at, b.status, case when b.direction = 'outbound' then b.sent_at end,
    case when b.status = 'failed' then 'send_failed' end,
    b.event, b.saved_to_candidate_id, b.saved_file_id, case when b.saved_file_id is not null then b.sent_at end
  from inbox_backfill b
  order by b.sent_at
  returning conversation_id, direction, historical
)
insert into inbox_backfill_inserted select conversation_id, direction, historical from inserted;

-- Take back exactly the unread the trigger added for these old messages.
update public.whatsapp_inbox_conversations c
set unread_count = greatest(0, c.unread_count - d.added),
    updated_at = now()
from (
  select conversation_id, count(*)::integer as added
  from inbox_backfill_inserted
  where direction = 'inbound' and not historical
  group by conversation_id
) d
where d.conversation_id = c.id;

-- Link a chat to its candidate when all its CVs reached the same one.
update public.whatsapp_inbox_conversations c
set candidate_id = l.candidate_id,
    linked_at = now(),
    updated_at = now()
from (
  select m.conversation_id, (array_agg(distinct b.candidate_id))[1] as candidate_id
  from inbox_backfill b
  join public.whatsapp_inbox_messages m on m.wamid = b.wamid
  where b.candidate_id is not null
  group by m.conversation_id
  having count(distinct b.candidate_id) = 1
) l
where l.conversation_id = c.id
  and c.candidate_id is null
  and c.employee_hr_id is null;

-- ── What applicants ANSWERED to Phoenix's own questions ─────────────────────────────────────────────
-- The classification flow never kept an applicant's reply as a message: a menu tap or a typed salary
-- was read, saved into ats_whatsapp_classification_sessions, and dropped. Without it a chat shows
-- Phoenix asking nine questions to silence. The answers are rebuilt from the session:
--   * each question is known from what Phoenix sent — a menu's row ids are `phx:<question>:<value>`,
--     a typed question by its wording (a "that looks too long" retry counts as the same question);
--   * the prompt belongs to the person's latest session started before it;
--   * a menu answer is the title of the row whose id carries the saved value (`other` when they typed
--     their own), so the bubble reads exactly what their phone showed; an extra question saves the
--     title itself;
--   * the answer is placed half a second before Phoenix's next message to them, which is what the
--     tap triggered, or at the session's end when nothing followed.
-- Only the LAST asking of a question per session gets an answer: an earlier, rejected reply was never
-- saved. Rows carry no WhatsApp message id — none was kept — so a re-run skips them by their tag.
-- message_type is `interactive` for a tap (the screen labels it "Chosen from the menu") and `text` for
-- a typed answer.
create temp table inbox_answers on commit drop as
with prompts as (
  select o.id, o.to_wa_id wa, o.phone_number_id line, o.created_at at, o.payload,
    case
      when o.event = 'whatsapp_classify_menu_send' then
        (select case when split_part(row_item->>'id', ':', 2) = 'extra' then 'extra:' || split_part(row_item->>'id', ':', 3) else split_part(row_item->>'id', ':', 2) end
           from jsonb_array_elements(coalesce(o.payload#>'{interactive,action,sections}', '[]'::jsonb)) sec,
                jsonb_array_elements(coalesce(sec->'rows', '[]'::jsonb)) row_item
          limit 1)
      when o.body like 'Last question — what monthly net salary%' or o.body like 'That looks a little long for a salary%' then 'salary'
      when o.body like 'No problem — please type what you graduated in%' or o.body like 'That looks longer than a background%' then 'background_other'
      when o.body like 'Please type the area or governorate%' then 'area_other'
      when o.body like 'No problem — please type the region%' then 'region_other'
      when o.body like 'No problem — please type the job title%' then 'job_title_other'
    end as qkey
  from public.ats_whatsapp_outbound_messages o
  where o.event in ('whatsapp_classify_menu_send', 'whatsapp_classify_text_send')
    and o.inbound_wamid is null and nullif(o.to_wa_id, '') is not null and o.phone_number_id is not null
),
assigned as (
  select p.*, s.id as session_id, s.completed_at, s.updated_at, s.job_title_family, s.job_title_other_text, s.region_code, s.region_other_text,
         s.area_name, s.area_other_text, s.background, s.background_other_text, s.experience, s.expected_salary, s.extra_answers,
         row_number() over (partition by s.id, p.qkey order by p.at desc) as rn
  from prompts p
  join lateral (
    select * from public.ats_whatsapp_classification_sessions s
    where s.wa_id = p.wa and s.phone_number_id = p.line and s.started_at <= p.at + interval '5 seconds'
    order by s.started_at desc limit 1
  ) s on true
  where p.qkey is not null
),
valued as (
  select a.*,
    case a.qkey
      when 'job_title' then 'phx:job_title:' || case when a.job_title_other_text is not null then 'other' else a.job_title_family end
      when 'region' then 'phx:region:' || case when a.region_other_text is not null then 'other' else a.region_code end
      when 'area' then 'phx:area:' || case when a.area_other_text is not null then 'other' else a.area_name end
      when 'background' then 'phx:background:' || case when a.background_other_text is not null then 'other' else a.background end
      when 'experience' then 'phx:experience:' || a.experience
    end as tapped_id,
    case
      when a.qkey = 'salary' then a.expected_salary
      when a.qkey = 'job_title_other' then a.job_title_other_text
      when a.qkey = 'region_other' then a.region_other_text
      when a.qkey = 'area_other' then a.area_other_text
      when a.qkey = 'background_other' then a.background_other_text
    end as typed,
    case when a.qkey like 'extra:%' then a.extra_answers->>substr(a.qkey, 7) end as extra_value
  from assigned a where a.rn = 1
)
select v.session_id, v.wa, v.line, v.qkey, v.at as prompt_at,
  case when v.typed is not null then 'text' else 'interactive' end as message_type,
  btrim(coalesce(
    v.typed,
    (select row_item->>'title' from jsonb_array_elements(coalesce(v.payload#>'{interactive,action,sections}', '[]'::jsonb)) sec,
            jsonb_array_elements(coalesce(sec->'rows', '[]'::jsonb)) row_item
      where (v.tapped_id is not null and row_item->>'id' = v.tapped_id)
         or (v.extra_value is not null and row_item->>'id' like 'phx:extra:' || substr(v.qkey, 7) || ':%' and row_item->>'title' = v.extra_value)
      limit 1),
    v.extra_value
  )) as body,
  (select min(n.created_at) from public.ats_whatsapp_outbound_messages n where n.to_wa_id = v.wa and n.phone_number_id = v.line and n.created_at > v.at) as next_at,
  coalesce(v.completed_at, v.updated_at) as session_end
from valued v;

-- A question never answered (the applicant stopped there) has no saved value: no bubble.
delete from inbox_answers where nullif(body, '') is null;
alter table inbox_answers add column answered_at timestamptz;
update inbox_answers set answered_at = case
  when next_at is not null then greatest(prompt_at + interval '1 millisecond', next_at - interval '500 milliseconds')
  when session_end > prompt_at then session_end
  else prompt_at + interval '1 second' end;

delete from inbox_answers a
using public.whatsapp_inbox_messages m
where m.payload->>'backfill' = 'ats_whatsapp_classification_sessions'
  and m.payload->>'sourceId' = a.session_id::text and m.payload->>'question' = a.qkey;

-- Once the inbox is live its webhook records the reply itself — a tap arrives as an `interactive`
-- message with its real id. So a question the person answered AFTER that started already has its
-- bubble: skip it when a live-recorded message from them sits between the question and Phoenix's next one.
delete from inbox_answers a
using public.whatsapp_inbox_messages m
where not (m.payload ? 'backfill')
  and m.direction = 'inbound'
  and m.contact_wa_id = a.wa
  and m.phone_number_id = a.line
  and m.sent_at >= a.prompt_at
  and m.sent_at <= coalesce(a.next_at, now());

create temp table inbox_answers_inserted (conversation_id uuid) on commit drop;
with inserted as (
  insert into public.whatsapp_inbox_messages (direction, origin, phone_number_id, contact_wa_id, message_type, body, payload, historical, sent_at, received_at, status, event)
  select 'inbound', 'contact', a.line, a.wa, a.message_type, a.body,
         jsonb_build_object('backfill', 'ats_whatsapp_classification_sessions', 'sourceId', a.session_id::text, 'question', a.qkey),
         false, a.answered_at, a.answered_at, 'received', 'whatsapp_inbox_backfill'
  from inbox_answers a order by a.answered_at
  returning conversation_id
)
insert into inbox_answers_inserted select conversation_id from inserted;

update public.whatsapp_inbox_conversations c
set unread_count = greatest(0, c.unread_count - d.added),
    updated_at = now()
from (select conversation_id, count(*)::integer as added from inbox_answers_inserted group by conversation_id) d
where d.conversation_id = c.id;

select
  (select count(*) from inbox_answers_inserted) as answers_inserted,
  (select count(*) from inbox_backfill) as candidates_to_insert,
  (select count(*) from inbox_backfill_inserted) as inserted,
  (select count(*) from inbox_backfill_inserted where direction = 'inbound') as inserted_inbound,
  (select count(*) from inbox_backfill_inserted where direction = 'outbound') as inserted_outbound,
  (select count(*) from public.whatsapp_inbox_conversations) as conversations,
  (select count(*) from public.whatsapp_inbox_conversations where candidate_id is not null) as linked_conversations,
  (select coalesce(sum(unread_count), 0) from public.whatsapp_inbox_conversations) as total_unread;

commit;
