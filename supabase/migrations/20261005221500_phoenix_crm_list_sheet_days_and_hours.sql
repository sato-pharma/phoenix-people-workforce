-- phoenix_crm_list_sheet_days_and_hours
--
-- WHAT THIS CHANGES:
--   1. `phoenix_crm_customers.intake_timings` — a new nullable jsonb column, shaped and bounded exactly
--      like `phoenix_crm_places.timings` (an array of 1..60 windows). It holds the days and hours the
--      SFE's list-template sheet named for a customer. It is a DRAFT: the rep is shown it pre-filled
--      when he validates the customer at the door, and what is stored on the PLACE is whatever he
--      confirms. Nothing reads this column after that.
--   2. `phoenix_crm_load_list_customers` — writes that column from the sheet's new "Days and hours"
--      column, and gains a second pass, `p -> 'hours'`, which attaches hours to a customer who is
--      ALREADY on the list and still waiting to be validated.
--
-- WHY:
--   🔴 OWNER INSTRUCTION, 2026-10-05, in chat: *"put the clinic days and hours in the SFE's
--   list-template sheet"*, answering the first field audit's largest measured number.
--
--   The audit (docs/phoenix-crm-field-audit-2026-10-05.md) counted every press the reps made in the
--   module's first three live days. Against 554 presses that recorded a call there were 3,728 presses of
--   registration, and 1,238 of those were the WEEKDAY BUTTONS of the timings editor: about 3 day-and-hour
--   rows typed by hand per customer, at the door, across lists of about 670 names each, with 355 of 9,087
--   customers validated — roughly fifteen more weeks of it. Whoever already knows a clinic's hours can
--   write them once in the sheet, and the rep then confirms them instead of building them from nothing.
--
--   🔴 THIS DOES NOT TOUCH THE FROZEN-PLACE RULE, AND THE NEXT PERSON TO READ IT MUST NOT "FIX" IT BACK.
--   A place's LOCATION is captured once at the door from a live photo and a GPS read, and its address,
--   brick, area and region are resolved server-side from that point (owner, 2026-09-23/29). That rule is
--   about the POSITION — a latitude in a spreadsheet is what it forbids. Days and hours are not a
--   position: they are already typed by hand by the rep into a plain form, and nothing in the system
--   measures them against anything. This column can never become a place: `phoenix_crm_insert_place` and
--   `phoenix_crm_validate_customer` do not read it, and they are not changed here.
--
--   🔴 THE SECOND PASS EXISTS BECAUSE THE FIRST ONE REACHES NOBODY WHO IS ALREADY WAITING. The 8,712
--   customers now pending were minted from iReports360, not loaded from a sheet, and the loader's own
--   same-name guard refuses them as `already_on_the_list` — correctly, since they ARE on it. So hours for
--   them arrive by NAME against the row that exists, and the guard is untouched: the second pass inserts
--   no customer, changes no status, no grade, no name and no list, and writes exactly one column.
--
--   It writes only while the customer is `pending` AND holds no place, which is the window in which
--   nothing has read the draft yet. Once he is validated the hours are the REP's, on his place, and this
--   column is never written or read again — so a re-upload cannot reach back and disagree with what he
--   confirmed standing at the door. Within that window a re-upload DOES overwrite, because the reason to
--   send the sheet again is to correct it.
--
-- ROLLBACK:
--   begin;
--     -- the function: re-apply 20261003090000_phoenix_crm_load_list_optional_grade.sql
--     alter table public.phoenix_crm_customers drop column if exists intake_timings;
--     notify pgrst, 'reload schema';
--   commit;
--   Dropping the column loses only drafts that no validated place has consumed.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration adds one nullable column and replaces one function body. It writes no row.

begin;
set local lock_timeout = '5s';

-- A nullable add with no default and no rewrite: ACCESS EXCLUSIVE for the catalogue update only.
alter table public.phoenix_crm_customers
  add column if not exists intake_timings jsonb;

comment on column public.phoenix_crm_customers.intake_timings is
  'Days and hours named by the SFE list-template sheet, as a DRAFT. Shown pre-filled to the rep when he '
  'validates at the door; the place stores what he confirms. Never a location, and never read after '
  'validation. Owner, 2026-10-05.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.phoenix_crm_customers'::regclass
      and conname = 'phoenix_crm_customers_intake_timings'
  ) then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_intake_timings
      check (
        intake_timings is null
        or (jsonb_typeof(intake_timings) = 'array' and jsonb_array_length(intake_timings) between 1 and 60)
      );
  end if;
end
$$;

create or replace function public.phoenix_crm_load_list_customers(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_source text := nullif(trim(coalesce(p ->> 'source', '')), '');
  v_row jsonb;
  v_name text;
  v_list_type text;
  v_grade text;
  v_potential text;
  v_timings jsonb;
  v_customer public.phoenix_crm_customers%rowtype;
  v_loaded jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_hours_set jsonb := '[]'::jsonb;
  v_hours_skipped jsonb := '[]'::jsonb;
  v_target uuid;
  v_load_id uuid := gen_random_uuid();
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'customers') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A sheet holds a territory's list, not a book. The caller caps it too; this is the floor under that.
  if jsonb_array_length(p -> 'customers') > 1000 then
    raise exception 'phoenix_crm:too_many_rows';
  end if;
  if jsonb_typeof(p -> 'hours') = 'array' and jsonb_array_length(p -> 'hours') > 1000 then
    raise exception 'phoenix_crm:too_many_rows';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  for v_row in select value from jsonb_array_elements(p -> 'customers')
  loop
    v_name := nullif(regexp_replace(trim(coalesce(v_row ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_list_type := coalesce(v_row ->> 'list_type', '');

    -- The caller has judged every one of these already (list-template-rules.ts). Checked again here
    -- because this function is the authority, and a refusal that reaches the sheet's own row number is
    -- more use to the SFE than one that aborts the whole load.
    if v_name is null or v_list_type not in ('AM', 'PM', 'Pharmacy') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'bad_input'));
      continue;
    end if;

    -- 🔴 GRADE AND POTENTIAL ARE OPTIONAL (owner, 2026-10-03). No row is refused over either one. The
    -- stored value is sanitised, not trusted: a pharmacy carries neither, and a doctor keeps his grade
    -- only when it is a real A/B/C and his potential only when it is a real AA..BC. Anything else —
    -- empty, unrecognised, or typed on a pharmacy — is written NULL. So a junk grade still cannot land;
    -- it is simply dropped instead of blocking the whole row.
    v_grade := case
      when v_list_type <> 'Pharmacy' and coalesce(v_row ->> 'grade', '') in ('A', 'B', 'C')
        then v_row ->> 'grade'
      else null
    end;
    v_potential := case
      when v_list_type <> 'Pharmacy' and coalesce(v_row ->> 'potential_grade', '') in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')
        then v_row ->> 'potential_grade'
      else null
    end;

    -- 🔴 THE DAYS AND HOURS ARE OPTIONAL IN EXACTLY THE SAME WAY (owner, 2026-10-05). The cell is free
    -- text a rep wrote; `list-sheet-hours.ts` reads it and hands over only what the module's own
    -- `parseTimings` accepted, so anything unreadable arrives as null and the row still loads. The shape
    -- is checked again here rather than trusted — this function is the authority — and the column's own
    -- CHECK is the floor under that.
    v_timings := case
      when jsonb_typeof(v_row -> 'timings') = 'array'
        and jsonb_array_length(v_row -> 'timings') between 1 and 60
        then v_row -> 'timings'
      else null
    end;

    -- The same guard a hand-typed customer meets, row by row rather than all or nothing: the SFE gets
    -- the ones that landed and a line naming each one that was already there.
    if exists (
      select 1
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending', 'outside')
        and c.list_type = v_list_type
        and lower(c.name) = lower(v_name)
    ) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'already_on_the_list'));
      continue;
    end if;

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, potential_grade, origin, status,
      validated_at, validated_by_hr_id, created_by_hr_id, is_test, phone, intake_where, intake_note,
      intake_timings
    )
    values (
      v_seat, v_line, v_list_type, left(v_name, 200),
      left(nullif(trim(coalesce(v_row ->> 'speciality', '')), ''), 120),
      v_grade, v_potential, 'new', 'pending',
      -- NOT validated: he waits under To validate for the rep to validate him at the door.
      null, null, v_actor, v_is_test,
      nullif(regexp_replace(coalesce(v_row ->> 'phone', ''), '\s+', '', 'g'), ''),
      left(nullif(trim(coalesce(v_row ->> 'intake_where', '')), ''), 200),
      left(nullif(trim(coalesce(v_row ->> 'intake_note', '')), ''), 300),
      v_timings
    )
    returning * into v_customer;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_customer.id, 'customer_loaded', v_actor,
      jsonb_build_object(
        'load_id', v_load_id,
        'source', coalesce(v_source, 'sheet'),
        'list_type', v_list_type,
        'grade', v_grade,
        'potential_grade', v_potential,
        'hours_from_sheet', v_timings is not null,
        'sheet_row', v_row -> 'row'
      ),
      v_is_test
    );

    v_loaded := v_loaded || jsonb_build_array(jsonb_build_object('customer_id', v_customer.id, 'name', v_customer.name, 'row', v_row -> 'row'));
  end loop;

  -- ── Hours for a customer who is already on the list ───────────────────────────────────────────────
  --
  -- 🔴 THIS PASS WRITES ONE COLUMN AND NOTHING ELSE. It inserts no customer, so the same-name guard
  -- above keeps its whole job; it never touches status, grade, potential, name, list or phone. It is the
  -- only way hours can reach the customers minted from iReports360, who are the overwhelming majority of
  -- everyone waiting to be validated.
  if jsonb_typeof(p -> 'hours') = 'array' then
    for v_row in select value from jsonb_array_elements(p -> 'hours')
    loop
      v_name := nullif(regexp_replace(trim(coalesce(v_row ->> 'name', '')), '\s+', ' ', 'g'), '');
      v_list_type := coalesce(v_row ->> 'list_type', '');
      v_timings := case
        when jsonb_typeof(v_row -> 'timings') = 'array'
          and jsonb_array_length(v_row -> 'timings') between 1 and 60
          then v_row -> 'timings'
        else null
      end;

      if v_name is null or v_list_type not in ('AM', 'PM', 'Pharmacy') or v_timings is null then
        v_hours_skipped := v_hours_skipped || jsonb_build_array(jsonb_build_object(
          'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'bad_input'));
        continue;
      end if;

      -- 🔴 PENDING AND PLACELESS, which is the window in which the draft has been read by nobody. Once
      -- the rep has validated him the hours are HIS, on his place, and a re-upload must not reach back
      -- and disagree with what he confirmed at the door.
      select c.id into v_target
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status = 'pending'
        and c.list_type = v_list_type
        and lower(c.name) = lower(v_name)
        and not exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = c.id)
      order by c.created_at
      limit 1;

      if v_target is null then
        v_hours_skipped := v_hours_skipped || jsonb_build_array(jsonb_build_object(
          'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'not_waiting_to_be_validated'));
        continue;
      end if;

      update public.phoenix_crm_customers
      set intake_timings = v_timings, updated_at = now()
      where id = v_target;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_target, 'customer_hours_loaded', v_actor,
        jsonb_build_object(
          'load_id', v_load_id,
          'source', coalesce(v_source, 'sheet'),
          'list_type', v_list_type,
          'windows', jsonb_array_length(v_timings),
          'sheet_row', v_row -> 'row'
        ),
        v_is_test
      );

      v_hours_set := v_hours_set || jsonb_build_array(jsonb_build_object('customer_id', v_target, 'name', v_name, 'row', v_row -> 'row'));
    end loop;
  end if;

  -- One event for the load itself, so the act is readable without reading 300 rows.
  insert into public.phoenix_crm_list_events (seat_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, 'list_loaded', v_actor,
    jsonb_build_object(
      'load_id', v_load_id,
      'source', coalesce(v_source, 'sheet'),
      'loaded', jsonb_array_length(v_loaded),
      'skipped', jsonb_array_length(v_skipped),
      'hours_set', jsonb_array_length(v_hours_set),
      'hours_skipped', jsonb_array_length(v_hours_skipped)
    ),
    v_is_test
  );

  return jsonb_build_object(
    'load_id', v_load_id,
    'seat_id', v_seat,
    'loaded', v_loaded,
    'skipped', v_skipped,
    'hours_set', v_hours_set,
    'hours_skipped', v_hours_skipped
  );
end;
$$;

revoke execute on function public.phoenix_crm_load_list_customers(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_load_list_customers(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
