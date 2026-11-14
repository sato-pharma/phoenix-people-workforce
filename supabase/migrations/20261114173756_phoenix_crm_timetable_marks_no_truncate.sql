-- phoenix_crm_timetable_marks_no_truncate
--
-- WHAT THIS CHANGES:
--   Takes TRUNCATE on `public.phoenix_crm_shared_place_timetable_marks` away from `service_role`, and
--   changes nothing else. Before it, production's service role held INSERT, REFERENCES, SELECT, TRIGGER
--   and TRUNCATE on the table (read 14 Nov 2026, 17:40 Cairo); after it, INSERT, REFERENCES, SELECT and
--   TRIGGER. The browser roles hold nothing on it before or after.
--
-- WHY:
--   The table is the append-only trail of who declared a building has no timetable and who took that
--   back (20261114155530). That migration took UPDATE and DELETE back from the service role so the app
--   can only add rows, but left TRUNCATE, which empties the whole trail in one statement and is not
--   filtered by row security. Owner, 14 Nov 2026: "fix the truncate grant". Nothing in the app
--   truncates it: the only writer is phoenix_crm_set_shared_place_no_timetable, which inserts.
--
-- ROLLBACK:
--   grant truncate on table public.phoenix_crm_shared_place_timetable_marks to service_role;
--
-- SAFE: no table is truncated here; this only takes the TRUNCATE privilege away.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied. This file
-- changes one privilege on one table and touches no row.

begin;

set local lock_timeout = '5s';

revoke truncate on table public.phoenix_crm_shared_place_timetable_marks from service_role;

-- The trail is append-only for the app: it may read and add rows, and nothing else that touches them.
do $$
declare
  v_left text;
begin
  select string_agg(privilege_type, ', ' order by privilege_type) into v_left
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'phoenix_crm_shared_place_timetable_marks'
    and grantee = 'service_role'
    and privilege_type in ('TRUNCATE', 'UPDATE', 'DELETE');
  if v_left is not null then
    raise exception 'phoenix_crm_shared_place_timetable_marks: service_role still holds %', v_left;
  end if;
  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'phoenix_crm_shared_place_timetable_marks'
      and grantee = 'service_role'
      and privilege_type = 'INSERT'
  ) then
    raise exception 'phoenix_crm_shared_place_timetable_marks: service_role lost INSERT, so the declaration could not write its trail';
  end if;
end;
$$;

commit;
