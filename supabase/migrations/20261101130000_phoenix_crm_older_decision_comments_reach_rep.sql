-- phoenix_crm_older_decision_comments_reach_rep
--
-- WHAT THIS CHANGES: it adds 51 visible place comments to phoenix_crm_place_notes, one for each decider's comment
-- written before the comment path of 2026-11-01 went live. It updates nothing and deletes nothing. Each new row keeps
-- the words, the decider and the time of the decision, so it reads as written then and not as written today.
--
-- WHY: the owner, 2026-11-01, asked who should see the older comments, chose "Rep and manager", and said: "i want the
-- rep to be able to the the decider comment and the manager of the rep can also see it".
--
-- LEFT OUT ON PURPOSE, 142 of the 193 older notes. The words stay in decision_note:
--   86 written by the system ("The system read the customer's name on the signboard."), which no decider wrote.
--   30 clean-up lines ("Duplicate of the same building..."). The owner chose to leave them out when shown them.
--   11 that are only "-", which say nothing.
--   15 identical lines that name another employee. A rep reads a role, never a name.
--
-- PRE-IMAGE: an insert has none. phoenix_crm_backup_20261101.older_decision_comments_added holds the id of every row
-- this file adds.
--
-- ROLLBACK (data only, nothing is dropped by this file):
--   delete from public.phoenix_crm_place_notes n
--     using phoenix_crm_backup_20261101.older_decision_comments_added b where b.note_id = n.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Announced to the owner in plain words BEFORE it was applied. Nothing is sent: a place comment carries no bell, no
-- Telegram and no email (docs/phoenix-crm-validation-feedback.md, "The comment written with a decision").
--
-- Idempotent: a comment already visible on its subject is skipped, so a re-run adds nothing. A database with fewer such
-- rows (staging, a fresh replay) adds fewer. More than the 51 the owner's answer covers refuses and rolls the file back.

begin;

create schema if not exists phoenix_crm_backup_20261101;
revoke all on schema phoenix_crm_backup_20261101 from public, anon, authenticated;

create table if not exists phoenix_crm_backup_20261101.older_decision_comments_added (note_id uuid primary key);
revoke all on all tables in schema phoenix_crm_backup_20261101 from public, anon, authenticated;

do $copy$
declare
  v_expected constant int := 51;
  v_added int;
begin
  with older as (
    select r.place_id, null::uuid as shared_place_id, p.customer_id, p.seat_id, p.is_test,
           r.decided_by_hr_id as author_hr_id, btrim(r.decision_note) as body, r.decided_at
    from public.phoenix_crm_validation_reviews r
    join public.phoenix_crm_places p on p.id = r.place_id
    where nullif(btrim(r.decision_note), '') is not null
    union all
    select null::uuid, s.id, null::uuid, s.seat_id, s.is_test,
           s.decided_by_hr_id, btrim(s.decision_note), s.decided_at
    from public.phoenix_crm_shared_places s
    where nullif(btrim(s.decision_note), '') is not null
  ),
  added as (
    insert into public.phoenix_crm_place_notes
      (place_id, shared_place_id, customer_id, seat_id, is_test, author_hr_id, author_source, body, rep_visible, created_at)
    select o.place_id, o.shared_place_id, o.customer_id, o.seat_id, o.is_test, o.author_hr_id, 'system_admin', o.body, true, o.decided_at
    from older o
    where o.decided_at < timestamptz '2026-11-01 10:03:00+00'
      and o.author_hr_id <> 'SYSTEM'
      and o.body <> '-'
      and o.body not ilike '%Ebtissam Alaa%'
      and o.body not like 'Duplicate of the same building%'
      and not exists (
        select 1 from public.phoenix_crm_place_notes n
        where n.rep_visible
          and n.body = o.body
          and n.place_id is not distinct from o.place_id
          and n.shared_place_id is not distinct from o.shared_place_id
      )
    returning id
  ),
  recorded as (
    insert into phoenix_crm_backup_20261101.older_decision_comments_added (note_id)
    select id from added
    returning note_id
  )
  select count(*) into v_added from recorded;

  if v_added > v_expected then
    raise exception 'older decision comments: % rows, expected at most %', v_added, v_expected;
  end if;

  raise notice 'older decision comments: added %', v_added;
end
$copy$;

commit;
