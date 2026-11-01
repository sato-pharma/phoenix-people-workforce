-- The in-app bell in ONE statement: phx_in_app_notices().
--
-- WHAT
--   One SQL function that answers everything the bell's list read used to ask in four requests:
--     1. the viewer's own notices (employee_hr_id), the notices that name the viewer (recipients) and,
--        for the one seat that is flooded by new-CV alerts, the viewer's other kinds on their own —
--        each arm fenced `scheduled_for <= p_today` and limited, exactly as the three PostgREST reads
--        were (src/lib/notifications/in-app.ts, listInAppNoticeBundleForViewer), merged by id;
--     2. the viewer's read / archived state for those rows (notification_user_states), by user id OR
--        HR id — the same two arms the state read carried;
--     3. the unread count of the viewer's newest twenty internal messages, which the envelope used to
--        fetch in a request of its own on every page view. The count is CAPPED at the newest twenty
--        deliberately: only those twenty are ever shown and marked read, so an all-history count
--        would be a badge that can never be cleared.
--   The function returns jsonb {events, states, unread_messages}; every filter the app applies after
--   the read (the personal-bell category allowlist, noticeIsDue, the seat window, the recipient
--   isolation rule, the test-login marker) stays in TypeScript and is unchanged.
--
-- WHY (owner, 2026-11-01: "find the ROOT root cause of the slowness")
--   Each read costs about 450 ms at Supabase's edge for 2-7 ms of SQL on the saturated 2-core host
--   (measured 1 Nov 2026, 10:30-11:00 Cairo: 36,104 requests in half an hour), so the number of
--   requests is the lever, not the statements. The pulse (every open tab, every minute) paid the
--   session read plus three or four requests for the bell plus one more for the envelope. Now it
--   pays the session read plus this one.
--
-- Security: SECURITY DEFINER with search_path pinned to public; executable by service_role only, as
-- every other phx_* function the app calls through the admin client. The arguments are the viewer's
-- own identifiers as the server resolved them from the session — never from a request body.
--
-- ROLLBACK
--   drop function if exists public.phx_in_app_notices(text, text, text, text, text[], date, integer, boolean, text);
--   (the app falls back to its four PostgREST reads on its own when the function is missing — PGRST202)

begin;
set local lock_timeout = '5s';

create or replace function public.phx_in_app_notices(
  p_hr_id text,
  p_user_id text,
  p_msg_hr_id text,
  p_login_id text,
  p_categories text[],
  p_today date,
  p_limit integer,
  p_other_kinds boolean,
  p_flooding_event_type text
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with own as (
    select e.*
    from public.notification_events e
    where coalesce(p_hr_id, '') <> ''
      and e.employee_hr_id = upper(p_hr_id)
      and e.category = any (p_categories)
      and e.scheduled_for <= p_today
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 8), 500))
  ),
  named as (
    select e.*
    from public.notification_events e
    where coalesce(p_hr_id, '') <> ''
      and e.recipients && array[p_hr_id]::text[]
      and e.category = any (p_categories)
      and e.scheduled_for <= p_today
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 8), 500))
  ),
  other_kinds as (
    -- The Talent Acquisition seat: her two reads above fill with new-CV alerts and reach back only a
    -- day or two, so her other notices are read on their own (seat-notice-filter.ts).
    select e.*
    from public.notification_events e
    where coalesce(p_other_kinds, false)
      and coalesce(p_hr_id, '') <> ''
      and e.employee_hr_id = upper(p_hr_id)
      and e.category = any (p_categories)
      and e.scheduled_for <= p_today
      and (e.event_type is null or e.event_type <> p_flooding_event_type)
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 8), 500))
  ),
  candidates as (
    select distinct on (c.id) c.*
    from (
      select * from own
      union all
      select * from named
      union all
      select * from other_kinds
    ) c
    order by c.id
  ),
  events as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'category', c.category,
          'subject', c.subject,
          'scheduled_for', c.scheduled_for,
          'sent_at', c.sent_at,
          'status', c.status,
          'metadata', c.metadata,
          'recipients', c.recipients,
          'employee_hr_id', c.employee_hr_id,
          'created_at', c.created_at,
          'module', c.module,
          'priority', c.priority,
          'action_url', c.action_url,
          'event_type', c.event_type,
          'test_login_id', c.test_login_id
        )
        order by c.created_at desc
      ),
      '[]'::jsonb
    ) as j
    from candidates c
  ),
  states as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'notification_event_id', s.notification_event_id,
          'user_id', s.user_id,
          'hr_id', s.hr_id,
          'read_at', s.read_at,
          'archived_at', s.archived_at
        )
      ),
      '[]'::jsonb
    ) as j
    from public.notification_user_states s
    where s.notification_event_id in (select id from candidates)
      and (
        (coalesce(p_user_id, '') <> '' and s.user_id = p_user_id)
        or s.hr_id = p_hr_id
      )
  ),
  newest_messages as (
    select m.read_at, m.recipient_hr_id, m.recipient_login_id
    from public.internal_messages m
    where (coalesce(p_msg_hr_id, '') <> '' and (m.recipient_hr_id = p_msg_hr_id or m.sender_hr_id = p_msg_hr_id))
       or (coalesce(p_login_id, '') <> '' and (m.recipient_login_id = p_login_id or m.sender_login_id = p_login_id))
    order by m.created_at desc
    limit 20
  ),
  unread_messages as (
    select count(*)::integer as n
    from newest_messages m
    where m.read_at is null
      and (
        (coalesce(p_msg_hr_id, '') <> '' and upper(trim(m.recipient_hr_id)) = upper(p_msg_hr_id))
        or (coalesce(p_login_id, '') <> '' and lower(m.recipient_login_id) = lower(p_login_id))
      )
  )
  select jsonb_build_object(
    'events', (select j from events),
    'states', (select j from states),
    'unread_messages',
      case
        when coalesce(p_msg_hr_id, '') = '' and coalesce(p_login_id, '') = '' then null
        else (select n from unread_messages)
      end
  );
$$;

comment on function public.phx_in_app_notices(text, text, text, text, text[], date, integer, boolean, text) is
  'The in-app bell in one statement (1 Nov 2026): the viewer''s notices (own, named, and the flooded seat''s other kinds), each fenced scheduled_for <= p_today; their read/archive states; the unread count of the newest 20 internal messages. Called by listInAppNoticeBundleForViewer; the app keeps every post-read filter.';

revoke execute on function public.phx_in_app_notices(text, text, text, text, text[], date, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.phx_in_app_notices(text, text, text, text, text[], date, integer, boolean, text) to service_role;

notify pgrst, 'reload schema';

commit;
