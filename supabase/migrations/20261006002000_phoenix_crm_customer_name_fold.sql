-- Phoenix CRM — the customer name match folds the name, the way the duplicate board already does.
--
-- WHY. Two keys were in use for one question. `server/duplicate-customers.ts` folds a name through
-- `normalizeContactName` — NFKC, Arabic diacritics and the tatweel, the hamza carriers أ إ آ ٱ onto
-- ا, final ى onto ي, final ة onto ه, punctuation, honorifics, case — and the loader compared
-- `lower(c.name) = lower(v_name)`. So the loader admitted a row the board then reported as a
-- duplicate, and nobody had prevented it.
--
-- MEASURED ON PRODUCTION, 2026-10-06. 2,708 of 9,137 customer names (29.6%) change under the fold,
-- and 8 groups on one seat and one list type hold the same customer twice where the raw key could
-- never have seen it — every one of them a pure orthography pair:
--
--     أحمد محمد الصباغ / احمد محمد الصباغ        (hamza carrier)
--     مستشفي مصطفى محمود / مستشفي مصطفي محمود    (final ى)
--     محمد الشكلى / محمد الشكلي                   (final ى)
--     أيسر بسالى / ايسر بسالي                     (both)
--     احمد شلبى / احمد شلبي                       (final ى)
--     أسلام نعيم / اسلام نعيم                     (hamza carrier)
--     صيدلية الحرية الجديدة / صيدلية الحرية الجديده  (final ة)
--     بيشوى نبيل / بيشوي نبيل                     (final ى)
--
-- 🔴 NOTHING IS MERGED OR DELETED HERE. The 55 existing duplicate groups stay exactly as they are:
-- removing one is the district-manager-then-SFE two-step the owner owns, and a unique index could
-- not be created over them anyway. This stops the NEXT one being created.
--
-- 🔴 AND IT ONLY EVER SKIPS. A folded hit takes the existing `already_on_the_list` branch, which
-- reports the row to the SFE and moves on; no row is overwritten, no name is rewritten, and a
-- customer who is genuinely a different person is unaffected because the fold changes spelling, not
-- identity.
--
-- The fold is duplicated in SQL because the guard lives inside the loader, and
-- `tests/phoenix-crm-customer-name-fold.test.ts` pins the two implementations to the same rule —
-- including the honorific list, which is the thing that would silently drift.

create or replace function public.phoenix_crm_fold_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $fold$
  -- The same rule as `normalizeContactName`, in the same order: NFKC, then the letter folds, then
  -- the diacritics and the tatweel, then everything that is not a letter or a number becomes a
  -- space, then the honorifics go, then the words are rejoined with single spaces.
  --
  -- Returns '' for a name that folds away to nothing. A caller must treat that as "no name" and
  -- never as a key — an empty key would collide every unnamed row onto one customer. The loader
  -- only ever reaches this with a non-empty name, because it refuses a nameless row earlier.
  select coalesce(btrim(string_agg(word, ' ' order by ord)), '')
  from (
    select word, ord
    from unnest(
      regexp_split_to_array(
        btrim(
          regexp_replace(
            regexp_replace(
              translate(lower(normalize(coalesce(p_name, ''), NFKC)), 'أإآٱىة', 'اااايه'),
              '[ًٌٍَُِّْٰـ]', '', 'g'),
            '[^[:alnum:][:space:]]', ' ', 'g')),
        '\s+')
    ) with ordinality as t(word, ord)
  ) words
  where word <> ''
    and word <> all (array[
      'د', 'دكتور', 'دكتوره', 'دكتورة', 'الدكتور', 'الدكتوره', 'دكتره',
      'dr', 'drs', 'doctor', 'prof', 'professor', 'mr', 'mrs', 'ms'
    ]);
$fold$;

comment on function public.phoenix_crm_fold_name(text) is
  'The Phoenix CRM customer name key: the SQL half of normalizeContactName. Folds Arabic orthography, diacritics, punctuation, honorifics and case so one customer has one key. Pinned by tests/phoenix-crm-customer-name-fold.test.ts.';

revoke execute on function public.phoenix_crm_fold_name(text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_fold_name(text) to service_role;

-- The loader, with its two name comparisons folded. The body below was taken from the live
-- function and proven byte-identical by md5 (893c9642aa53799b4a9f949f13a40ab5) before the only
-- change was made: `lower(c.name) = lower(v_name)` became the folded comparison, in the
-- customer-insert guard and in the days-and-hours pass.
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
        and public.phoenix_crm_fold_name(c.name) = public.phoenix_crm_fold_name(v_name)
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
        and public.phoenix_crm_fold_name(c.name) = public.phoenix_crm_fold_name(v_name)
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
