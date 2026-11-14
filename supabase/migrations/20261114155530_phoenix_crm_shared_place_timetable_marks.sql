-- phoenix_crm_shared_place_timetable_marks
--
-- WHAT THIS CHANGES:
--   1. ONE new table, `public.phoenix_crm_shared_place_timetable_marks`: one row each time a building
--      is declared to have no timetable, and one each time that is taken back. Append-only. A
--      take-back row also keeps who had declared it and when, because the building's own two columns
--      are cleared at that moment.
--   2. ONE new function, `public.phoenix_crm_set_shared_place_no_timetable(jsonb)`: the declaration
--      and its take-back, written with their trail row in one transaction. It sets or clears the same
--      two columns the app wrote directly until now (`timetable_exempt_at`,
--      `timetable_exempt_by_hr_id` on `phoenix_crm_shared_places`) and nothing else on the building.
--   3. ONE row per building that is declared today (1 on production on 14 Nov 2026, 0 on staging),
--      copied from the building's own two columns, so the trail starts with what is already true.
--   No existing table, column, constraint, function or grant is altered.
--
-- WHY:
--   Owner, 14 Nov 2026: "Record who took back". The declaration ("This building has no timetable",
--   PR 402) is the Super Admin's and can be taken back on the same row. Taking it back cleared who
--   declared it and when, and nothing recorded who took it back: the building simply read as never
--   declared. The trail keeps both, every time, and the board shows the last take-back on the
--   building's own row.
--
--   The marker is still a SCREEN marker only. Nothing here validates, holds or tells anybody, and
--   nothing reads the trail to decide anything.
--
-- ROLLBACK:
--   `drop function if exists public.phoenix_crm_set_shared_place_no_timetable(jsonb);`
--   `drop table if exists public.phoenix_crm_shared_place_timetable_marks;` -- loses the trail only.
--   The code that calls the function and reads the table must be reverted first, or the declaration
--   answers PGRST202 and the board read PGRST205. The two columns on the building are untouched by a
--   rollback, so every declaration in force stays in force.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied. This
-- file creates one table and one function and inserts one row per declared building; it changes and
-- deletes nothing.

begin;

set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_shared_place_timetable_marks (
  id bigint generated always as identity primary key,
  shared_place_id uuid not null references public.phoenix_crm_shared_places (id) on delete cascade,
  action text not null,
  actor_hr_id text not null,
  acted_at timestamptz not null default now(),
  -- A take-back only: the declaration it ended, as the building's two columns read at that moment.
  declared_at timestamptz,
  declared_by_hr_id text,
  constraint phoenix_crm_shared_place_timetable_marks_action_check
    check (action in ('declared', 'taken_back')),
  constraint phoenix_crm_shared_place_timetable_marks_ended_check
    check ((action = 'taken_back') = (declared_at is not null) and (declared_at is null) = (declared_by_hr_id is null))
);

comment on table public.phoenix_crm_shared_place_timetable_marks is
  'Append-only trail of the "This building has no timetable" declaration on a polyclinic or centre: one row when the Super Admin declares it, one when he takes it back. Written only by phoenix_crm_set_shared_place_no_timetable. Nothing validates a customer off it.';
comment on column public.phoenix_crm_shared_place_timetable_marks.actor_hr_id is
  'Who declared it, or who took it back.';
comment on column public.phoenix_crm_shared_place_timetable_marks.declared_at is
  'On a take-back: when the declaration it ended had been made. Null on a declaration.';
comment on column public.phoenix_crm_shared_place_timetable_marks.declared_by_hr_id is
  'On a take-back: who had made the declaration it ended. Null on a declaration.';

-- The index of the foreign key, leading with its column; the board reads the latest row of a building.
create index if not exists phoenix_crm_shared_place_timetable_marks_shared_place_id_fk_idx
  on public.phoenix_crm_shared_place_timetable_marks (shared_place_id, acted_at desc, id desc);

alter table public.phoenix_crm_shared_place_timetable_marks enable row level security;
-- Append-only for the app too: a new table is born with every privilege for service_role, so they are
-- taken away first and only read and insert are given back.
revoke all on table public.phoenix_crm_shared_place_timetable_marks from public, anon, authenticated, service_role;
grant select, insert on table public.phoenix_crm_shared_place_timetable_marks to service_role;

-- The trail starts with what is already true: every building declared today gets its declaration row,
-- from its own two columns. Safe to re-apply: a building that already has a row is left alone.
insert into public.phoenix_crm_shared_place_timetable_marks (shared_place_id, action, actor_hr_id, acted_at)
select sp.id, 'declared', sp.timetable_exempt_by_hr_id, sp.timetable_exempt_at
from public.phoenix_crm_shared_places sp
where sp.timetable_exempt_at is not null
  and not exists (
    select 1 from public.phoenix_crm_shared_place_timetable_marks m where m.shared_place_id = sp.id
  );

create or replace function public.phoenix_crm_set_shared_place_no_timetable(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'shared_place_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_declared boolean := case p ->> 'declared' when 'true' then true when 'false' then false else null end;
  v_place public.phoenix_crm_shared_places%rowtype;
begin
  if v_id is null or v_actor is null or v_declared is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The row lock is what stops two clicks from both landing: the second reads the first one's state.
  select * into v_place from public.phoenix_crm_shared_places sp where sp.id = v_id for update;
  if not found then
    return jsonb_build_object('outcome', 'missing');
  end if;
  -- A rejected building is never written.
  if v_place.status not in ('active', 'held') then
    return jsonb_build_object('outcome', 'retired');
  end if;
  if v_declared = (v_place.timetable_exempt_at is not null) then
    return jsonb_build_object('outcome', 'unchanged');
  end if;

  if v_declared then
    update public.phoenix_crm_shared_places sp
    set timetable_exempt_at = now(), timetable_exempt_by_hr_id = v_actor, updated_at = now()
    where sp.id = v_id;

    insert into public.phoenix_crm_shared_place_timetable_marks (shared_place_id, action, actor_hr_id, acted_at)
    values (v_id, 'declared', v_actor, now());
  else
    update public.phoenix_crm_shared_places sp
    set timetable_exempt_at = null, timetable_exempt_by_hr_id = null, updated_at = now()
    where sp.id = v_id;

    -- Who took it back, and the declaration it ended: the two columns were just cleared.
    insert into public.phoenix_crm_shared_place_timetable_marks
      (shared_place_id, action, actor_hr_id, acted_at, declared_at, declared_by_hr_id)
    values (v_id, 'taken_back', v_actor, now(), v_place.timetable_exempt_at, v_place.timetable_exempt_by_hr_id);
  end if;

  return jsonb_build_object('outcome', 'written', 'shared_place_id', v_id, 'name', v_place.name, 'declared', v_declared);
end;
$$;

comment on function public.phoenix_crm_set_shared_place_no_timetable(jsonb) is
  'Declare that a polyclinic or centre has no timetable, or take that back, and write the trail row with it. Sets or clears the two marker columns on the building and nothing else. Answers outcome written | missing | retired | unchanged.';

revoke execute on function public.phoenix_crm_set_shared_place_no_timetable(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_set_shared_place_no_timetable(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
