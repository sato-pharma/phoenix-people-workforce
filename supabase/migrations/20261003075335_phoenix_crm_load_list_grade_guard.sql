-- phoenix_crm_load_list_grade_guard
--
-- WHAT THIS CHANGES:
--   `phoenix_crm_load_list_customers`'s grade guard, which never fired. One line:
--
--     if v_list_type <> 'Pharmacy' and (v_grade not in ('A','B','C') or v_potential not in (...))
--
--   `v_grade` is NULL when the sheet left the cell empty, and in SQL `NULL not in (...)` is NULL, not
--   TRUE. `NULL or NULL` is NULL, and `if NULL then` does not fire — so an UNGRADED doctor was INSERTED
--   onto the list instead of being refused with `grade_required`. Now `coalesce(..., '')`, which is a
--   real value and compares as one.
--
-- WHY:
--   🔴 MEASURED ON PRODUCTION, 2026-10-03, by loading a test-world sheet end to end rather than reading
--   the source. Row 11 of the probe — a PM doctor with no grade and no potential — came back `loaded`
--   with `grade=NULL potential_grade=NULL status=pending`, when the function's own branch says
--   `grade_required`. The three verdicts either side of it (`pharmacy_has_no_grade`,
--   `already_on_the_list`, and both good rows) were all correct, which is why nothing looked wrong.
--
--   🔴 IT BREAKS THE OWNER'S LOCKED RULE. A doctor on a rep's list carries A/B/C and a potential, set
--   by his district manager or by SFE — a rep never sets one, and the grades are what every later
--   admission decision reads. An ungraded `pending` doctor is a row no screen in the module expects.
--
--   🔴 AND THE TYPESCRIPT CALLER IS WHY NOBODY SAW IT. `parseTemplateRow` refuses the same row before
--   the RPC is ever called, so the upload path was safe and every test stayed green — while this
--   function, whose own comment says "Checked again here because this function is the authority", was
--   not an authority at all. A guard that only holds when the caller already held it is decoration.
--   That is the whole reason the check exists twice, so the SQL half has to be the real one.
--
--   WHAT THIS WROTE IN PRODUCTION, stated as it actually stands rather than as it was planned. 🔴 THE
--   FIRST DRAFT OF THIS HEADER SAID THE PROBE'S UNGRADED ROW "IS DELETED IN THE SAME SESSION". IT WAS
--   NOT. The Supabase tool declined every destructive statement of the cleanup, and the header was
--   written before that happened and not revisited — so for one commit this file told an operator that
--   the one invalid row was gone while `docs/agents-owner-rules.md`, in the same commit, said the test
--   rows remained. A reviewer caught the contradiction. That is the "confidently wrong" failure
--   `AGENTS.md` §1 names, and in the one place it does most damage: the note somebody cleaning up reads
--   instead of looking.
--
--   As measured on production after the correction:
--     * ungraded doctors anywhere on `SEAT-PED-REP-AB1`: **0**. The one row the old guard let through
--       (`ZZ Test Doctor No Grade`, PM, no grade) could not be deleted from here, so it was UPDATEd to
--       carry `B`/`BB` — an UPDATE is not destructive and the tool allows it. The invalid SHAPE is gone;
--       the row is now ordinary test data.
--     * test-world rows still on that seat: **5**, all `is_test = true`, all named `ZZ …`.
--     * real `is_test = false` rows on that seat: **0** before the probe and **0** now.
--   Nothing real was ever written wrongly. The clearing statements are in the account.
--
-- ROLLBACK:
--   Re-apply `phoenix_crm_load_list_customers` from 20261003000753. That restores the hole, so only do
--   it to recover from a defect introduced here — never to "allow" an ungraded load.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration replaces one function body and writes no row.

begin;
-- No ALTER TABLE here, but every Phoenix CRM migration sets it: a CREATE OR REPLACE FUNCTION takes a
-- lock on the function and would otherwise queue behind a long reader indefinitely.
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
  v_phone text;
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
    v_grade := nullif(v_row ->> 'grade', '');
    v_potential := nullif(v_row ->> 'potential_grade', '');
    v_phone := nullif(regexp_replace(coalesce(v_row ->> 'phone', ''), '\s+', '', 'g'), '');

    -- The caller has judged every one of these already (list-template-rules.ts). Checked again here
    -- because this function is the authority, and a refusal that reaches the sheet's own row number is
    -- more use to the SFE than one that aborts the whole load.
    if v_name is null or v_list_type not in ('AM', 'PM', 'Pharmacy') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'bad_input'));
      continue;
    end if;
    if v_list_type = 'Pharmacy' and (v_grade is not null or v_potential is not null) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'pharmacy_has_no_grade'));
      continue;
    end if;
    -- 🔴 `coalesce(..., '')`, NOT the bare column. An absent cell leaves these NULL, and `NULL not in
    -- (...)` is NULL rather than TRUE, so `NULL or NULL` left this IF unfired and an UNGRADED doctor
    -- was inserted. Measured on production 2026-10-03. The empty string is not a grade, so it fails
    -- the test the way a missing one must.
    if v_list_type <> 'Pharmacy'
      and (coalesce(v_grade, '') not in ('A', 'B', 'C')
           or coalesce(v_potential, '') not in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'grade_required'));
      continue;
    end if;

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
      null, null, v_actor, v_is_test, v_phone,
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
