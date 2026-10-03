-- phoenix_crm_load_list_optional_grade
--
-- WHAT THIS CHANGES:
--   `phoenix_crm_load_list_customers` — the bulk loader behind the SFE's list-template upload. The grade
--   and the potential are now OPTIONAL on the sheet. Two skip branches are removed:
--
--     * the `grade_required` branch (added in 20261003075335): a doctor with no grade and/or no potential
--       is now LOADED as `pending` with the missing field NULL, instead of being refused;
--     * the `pharmacy_has_no_grade` branch: a pharmacy that happens to carry a typed grade or potential is
--       now LOADED with both NULL, instead of being refused.
--
--   The stored value is sanitised on insert rather than trusted: a doctor keeps his grade only when it is
--   a real A/B/C and his potential only when it is a real AA..BC; anything else — empty, unrecognised, or
--   on a pharmacy — is written NULL. So the function still cannot write a junk grade; it simply no longer
--   refuses the row over one.
--
-- WHY:
--   🔴 OWNER INSTRUCTION, 2026-10-03, in chat, with the upload open in front of him: *"make the grade and
--   the potential optional, not required"*, after an SFE's 170-row sheet came back "0 of 170 loaded" — the
--   doctor rows refused for an empty Potential and the pharmacy rows for a typed Grade. Asked directly how
--   a pharmacy with a grade typed on it should be handled, he chose *"ignore it, let them load."*
--
--   This loosens ONLY the bulk sheet. The ordinary admission door is untouched: a rep still never sets a
--   grade, and `phoenix_crm_decide_request` still REQUIRES a potential before a district manager approves
--   an add (`phoenix_crm:potential_grade_required`). The sheet route exists for a whole list loaded at
--   once, or a territory whose manager chain is vacant, and the owner has made its grades optional.
--
--   The TypeScript caller (`list-template-rules.ts`) is changed in the same PR to match: it no longer
--   refuses a row over grade or potential, so the two halves agree — the lesson of 20261003075335, where a
--   guard held only because the caller held it first.
--
-- ROLLBACK:
--   Re-apply 20261003075335 (the `grade_required` guard) and 20261003000753. That restores the hard
--   requirement — only do it to recover from a defect introduced here, never to re-tighten by surprise.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration replaces one function body and writes no row.

begin;
-- A CREATE OR REPLACE FUNCTION takes a lock on the function and would otherwise queue behind a long
-- reader indefinitely.
set local lock_timeout = '5s';

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
  v_customer public.phoenix_crm_customers%rowtype;
  v_loaded jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_load_id uuid := gen_random_uuid();
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'customers') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A sheet holds a territory's list, not a book. The caller caps it too; this is the floor under that.
  if jsonb_array_length(p -> 'customers') > 1000 then
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
      validated_at, validated_by_hr_id, created_by_hr_id, is_test, phone, intake_where, intake_note
    )
    values (
      v_seat, v_line, v_list_type, left(v_name, 200),
      left(nullif(trim(coalesce(v_row ->> 'speciality', '')), ''), 120),
      v_grade, v_potential, 'new', 'pending',
      -- NOT validated: he waits under To validate for the rep to validate him at the door.
      null, null, v_actor, v_is_test,
      nullif(regexp_replace(coalesce(v_row ->> 'phone', ''), '\s+', '', 'g'), ''),
      left(nullif(trim(coalesce(v_row ->> 'intake_where', '')), ''), 200),
      left(nullif(trim(coalesce(v_row ->> 'intake_note', '')), ''), 300)
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
        'sheet_row', v_row -> 'row'
      ),
      v_is_test
    );

    v_loaded := v_loaded || jsonb_build_array(jsonb_build_object('customer_id', v_customer.id, 'name', v_customer.name, 'row', v_row -> 'row'));
  end loop;

  -- One event for the load itself, so the act is readable without reading 300 rows.
  insert into public.phoenix_crm_list_events (seat_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, 'list_loaded', v_actor,
    jsonb_build_object(
      'load_id', v_load_id,
      'source', coalesce(v_source, 'sheet'),
      'loaded', jsonb_array_length(v_loaded),
      'skipped', jsonb_array_length(v_skipped)
    ),
    v_is_test
  );

  return jsonb_build_object(
    'load_id', v_load_id,
    'seat_id', v_seat,
    'loaded', v_loaded,
    'skipped', v_skipped
  );
end;
$$;

revoke execute on function public.phoenix_crm_load_list_customers(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_load_list_customers(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
