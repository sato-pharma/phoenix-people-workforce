-- Make the organogram seat a real foreign key of the hiring ledger.
--
-- THE GAP THIS CLOSES (owner-identified 2026-08-05): `au.seats` is the source of truth for org
-- structure, but NOTHING outside the `au` schema referenced a seat. `position_vacancies` had no
-- seat column and `employees` has none either — verified against information_schema. Every link
-- between the truth and the rest of the system was re-derived, every time, by matching text
-- (line + area + manager + job_title). That single omission is the common root of:
--
--   * duplicate open vacancies — "duplicate" was undefinable without a seat to key on;
--   * hires that silently never reach a seat — the autofill had to GUESS the seat through three
--     text-matching tiers (20260804105756), and a duplicated slot made every tier ambiguous;
--   * vacancies for seats that do not exist — see VAC-PEDIA-CAIRO-DOWNTOWN-SHOUBRA-MR below.
--
-- Measured on production before writing this (all 87 rows):
--   59 rep vacancies resolve to EXACTLY ONE seat        -> backfilled here
--   27 manager / head-office rows have no rep seat       -> seat_id stays NULL, by design
--    1 row resolves to NO seat                           -> left NULL and reported (see below)
--    0 rows are AMBIGUOUS                                -> the backfill needs no judgement calls
--
-- The 1 unresolvable row is `VAC-PEDIA-CAIRO-DOWNTOWN-SHOUBRA-MR`: a Pedia rep vacancy for
-- Down town (CA5), an area Pedia does not staff (only CNS has a Down town rep seat; Pedia maps
-- CA5 to the "Others" region). It is left with a NULL seat_id deliberately — inventing a seat
-- would corrupt the structure, and cancelling it is the owner's call, not this migration's.
--
-- DEDUPLICATION IS A CONSEQUENCE, NOT A SEPARATE DECISION. The partial unique index below cannot
-- exist while one seat carries several open vacancies, so the 8 duplicate rows are cancelled here
-- under a deterministic rule (see step 3). Every cancellation is audited by
-- trg_position_vacancies_audit (20260805010000), so each one is reversible from its audit row.
--
-- Data impact: 59 rows gain a seat_id; 8 duplicate open rows move to 'cancelled'. No row is
-- deleted. The `au` schema is NOT touched — organogram structure and occupancy are untouched by
-- construction (verified by rolled-back probe: au.seats 133->133, occupancy 151->151).
--
-- Rollback:
--   drop index if exists position_vacancies_one_open_per_seat;
--   alter table public.position_vacancies drop column if exists seat_id;
--   -- and restore the 8 statuses from their audit_logs rows (entity_type = 'position_vacancy').

-- ---------------------------------------------------------------------------
-- 1. The column and the foreign key.
-- ---------------------------------------------------------------------------

alter table public.position_vacancies
  add column if not exists seat_id text;

comment on column public.position_vacancies.seat_id is
  'The au.seats seat this vacancy recruits for. NULL for manager/head-office vacancies, which have no rep seat by design. When set, it is authoritative: the hire chain seats the new employee here instead of guessing from line+area text.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'position_vacancies_seat_id_fkey'
  ) then
    alter table public.position_vacancies
      add constraint position_vacancies_seat_id_fkey
      foreign key (seat_id) references au.seats(seat_id)
      on update cascade on delete set null;
  end if;
end $$;

create index if not exists position_vacancies_seat_id_idx
  on public.position_vacancies (seat_id);

-- ---------------------------------------------------------------------------
-- 2. Backfill: rep vacancies whose (line, area) resolves to exactly one active REP seat.
--    The `= 1` guard means an ambiguous row would be skipped rather than guessed.
-- ---------------------------------------------------------------------------

update public.position_vacancies pv
   set seat_id = resolved.seat_id
  from (
    select v.id,
           (select s.seat_id
              from au.seats s
             where s.seat_tier = 'REP'
               and s.is_active
               and s.effective_to is null
               and s.line_code = l.code
               and s.area_code = a.code
             limit 1) as seat_id
      from public.position_vacancies v
      join public.lines l on l.id = v.line_id
      join public.areas a on a.id = v.area_id
      join public.positions p on p.id = v.position_id
     where p.code = 'medical_representative'
       and (select count(*)
              from au.seats s2
             where s2.seat_tier = 'REP'
               and s2.is_active
               and s2.effective_to is null
               and s2.line_code = l.code
               and s2.area_code = a.code) = 1
  ) as resolved
 where pv.id = resolved.id
   and resolved.seat_id is not null
   and pv.seat_id is distinct from resolved.seat_id;

-- ---------------------------------------------------------------------------
-- 3. Collapse duplicate OPEN vacancies to one per seat.
--
--    Deterministic keeper rule, in order:
--      a. a row naming a departed predecessor beats a bare structural row — it carries the
--         information the hire chain uses to inherit that person's seat;
--      b. then the most recently created row — it reflects the latest lifecycle event;
--      c. then the lowest id — so a same-day tie keeps the ORIGINAL row rather than a later
--         mislabelled copy (this is what keeps `vacancy_12 … sharkia_2` and cancels
--         `vacancy_13 … sharkia_3`, which points at Sharkia 2 despite its name).
-- ---------------------------------------------------------------------------

with ranked as (
  select pv.id,
         row_number() over (
           partition by pv.seat_id
           order by (case when nullif(btrim(coalesce(pv.replacement_for_hr_id, '')), '') is not null
                          then 0 else 1 end),
                    pv.created_at desc,
                    pv.id asc
         ) as keep_rank
    from public.position_vacancies pv
   where pv.seat_id is not null
     and lower(coalesce(pv.status, 'open')) = 'open'
)
update public.position_vacancies pv
   set status = 'cancelled',
       note = concat_ws(
         E'\n',
         nullif(pv.note, ''),
         'Auto-cancelled by the seat_id migration (20260805020000): another open vacancy already '
           || 'recruits for seat ' || pv.seat_id || '. Duplicate open vacancies made the hire '
           || 'autofill match neither row, so a new hire never reached this seat.'
       ),
       updated_at = now()
  from ranked
 where pv.id = ranked.id
   and ranked.keep_rank > 1;

-- ---------------------------------------------------------------------------
-- 4. The law: at most ONE open vacancy per seat. Duplicates are now impossible,
--    not merely discouraged.
-- ---------------------------------------------------------------------------

create unique index if not exists position_vacancies_one_open_per_seat
  on public.position_vacancies (seat_id)
  where seat_id is not null and lower(coalesce(status, 'open')) = 'open';

-- ---------------------------------------------------------------------------
-- 5. The hire chain resolves by seat_id FIRST; the text-matching tiers survive only for
--    seat-less rows (manager / head-office vacancies). Body otherwise identical to
--    20260804190000, including the already-seated guard added there.
-- ---------------------------------------------------------------------------

create or replace function public.phx_hire_into_seat_on_vacancy_filled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_predecessor_hr_id text := nullif(btrim(old.replacement_for_hr_id), '');
  v_new_hr_id         text := nullif(btrim(new.filled_by_hr_id), '');
  v_seat_id           text;
  v_resolved_by       text;
  v_line_code         text;
  v_area_code         text;
  v_position_code     text;
  v_match_count       integer := 0;
  v_existing_seats    text;
  v_effective_date    date := coalesce(
    (new.filled_at at time zone 'Africa/Cairo')::date,
    (now() at time zone 'Africa/Cairo')::date
  );
begin
  if v_new_hr_id is null then
    return new;
  end if;

  -- Route 0 (authoritative): the vacancy names its own seat. No guessing.
  v_seat_id := nullif(btrim(coalesce(new.seat_id, '')), '');
  if v_seat_id is not null then
    v_resolved_by := 'vacancy_seat_id';
  end if;

  -- Route 1: inherit the predecessor's seat.
  if v_seat_id is null and v_predecessor_hr_id is not null then
    v_seat_id := au.f_last_occupied_seat_by_hr_id(v_predecessor_hr_id);
    if v_seat_id is not null then
      v_resolved_by := 'predecessor_seat';
    end if;
  end if;

  -- Route 2: no predecessor (or their seat is gone) -- resolve from line + area.
  if v_seat_id is null then
    select l.code into v_line_code from public.lines l where l.id = new.line_id;
    select a.code into v_area_code from public.areas a where a.id = new.area_id;
    select p.code into v_position_code from public.positions p where p.id = new.position_id;

    if v_position_code = 'medical_representative'
       and v_line_code is not null
       and v_area_code is not null then
      select count(*), min(s.seat_id)
        into v_match_count, v_seat_id
        from au.seats s
       where s.seat_tier = 'REP'
         and s.is_active
         and s.effective_to is null
         and s.line_code = v_line_code
         and s.area_code = v_area_code
         and not exists (
           select 1
             from au.occupancy_history o
            where o.seat_id = s.seat_id
              and o.effective_to is null
              and o.occupant_hr_id is not null
         );

      if v_match_count = 1 then
        v_resolved_by := 'line_area_match';
      else
        v_seat_id := null;
      end if;
    end if;
  end if;

  -- Never fail silently.
  if v_seat_id is null then
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values (
        'system', 'au_seat_hire_unresolved', v_new_hr_id,
        format('No au seat resolved for %s via vacancy %s - they will not appear on the organogram until a seat is assigned',
          v_new_hr_id, coalesce(new.vacancy_code, new.id::text)),
        jsonb_build_object(
          'vacancyId', new.id,
          'vacancyCode', new.vacancy_code,
          'predecessorHrId', v_predecessor_hr_id,
          'lineCode', v_line_code,
          'areaCode', v_area_code,
          'positionCode', v_position_code,
          'candidateSeatMatches', v_match_count
        )
      );
    exception when others then
      null;
    end;
    return new;
  end if;

  -- Person-level guard: never auto-seat someone who already holds an open seat span.
  select string_agg(oh.seat_id, ', ' order by oh.seat_id)
    into v_existing_seats
    from au.occupancy_history oh
   where oh.occupant_canonical_hr_id = lower(v_new_hr_id)
     and oh.effective_to is null
     and oh.occupant_hr_id is not null;
  if v_existing_seats is not null then
    if v_existing_seats = v_seat_id then
      begin
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values (
          'system', 'au_seat_hire', v_new_hr_id,
          format('%s already occupies au seat %s - vacancy %s closed with no seat change',
            v_new_hr_id, v_seat_id, coalesce(new.vacancy_code, new.id::text)),
          jsonb_build_object(
            'seatId', v_seat_id,
            'vacancyId', new.id,
            'vacancyCode', new.vacancy_code,
            'resolvedBy', coalesce(v_resolved_by, 'unknown'),
            'noop', true
          )
        );
      exception when others then
        null;
      end;
    else
      begin
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values (
          'system', 'au_seat_hire_blocked', v_new_hr_id,
          format('BLOCKED: %s already occupies seat(s) %s - refused to also seat them on %s via vacancy %s. Use the Transfer Seat action to move them instead.',
            v_new_hr_id, v_existing_seats, v_seat_id, coalesce(new.vacancy_code, new.id::text)),
          jsonb_build_object(
            'targetSeatId', v_seat_id,
            'existingSeatIds', v_existing_seats,
            'vacancyId', new.id,
            'vacancyCode', new.vacancy_code,
            'predecessorHrId', v_predecessor_hr_id,
            'resolvedBy', coalesce(v_resolved_by, 'unknown')
          )
        );
      exception when others then
        null;
      end;
    end if;
    return new;
  end if;

  begin
    perform au.hire_into_seat(v_seat_id, v_new_hr_id, v_effective_date, 'vacancy_fill_trigger');
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      'system', 'au_seat_hire', v_new_hr_id,
      format('Auto-hired into au seat %s via vacancy %s (resolved by %s)',
        v_seat_id, coalesce(new.vacancy_code, new.id::text), v_resolved_by),
      jsonb_build_object(
        'seatId', v_seat_id,
        'predecessorHrId', v_predecessor_hr_id,
        'vacancyId', new.id,
        'vacancyCode', new.vacancy_code,
        'resolvedBy', v_resolved_by
      )
    );
  exception when others then
    raise warning 'phx_hire_into_seat_on_vacancy_filled: au.hire_into_seat(%, %) failed: %',
      v_seat_id, v_new_hr_id, sqlerrm;
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values (
        'system', 'au_seat_hire_failed', v_new_hr_id,
        format('Failed to auto-hire into au seat %s (resolved by %s): %s',
          v_seat_id, coalesce(v_resolved_by, 'unknown'), sqlerrm),
        jsonb_build_object(
          'seatId', v_seat_id,
          'predecessorHrId', v_predecessor_hr_id,
          'vacancyId', new.id,
          'resolvedBy', v_resolved_by,
          'error', sqlerrm
        )
      );
    exception when others then
      null;
    end;
  end;

  return new;
end;
$function$;

revoke execute on function public.phx_hire_into_seat_on_vacancy_filled() from public, anon, authenticated;
grant execute on function public.phx_hire_into_seat_on_vacancy_filled() to service_role;

-- ---------------------------------------------------------------------------
-- 6. A resignation-opened vacancy inherits the seat its occupant is vacating, so the
--    replacement lands on the right seat without any text matching at all.
-- ---------------------------------------------------------------------------

create or replace function public.phx_stamp_vacancy_seat_from_predecessor()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_seat_id text;
  v_open_seats integer := 0;
  v_predecessor text := nullif(btrim(coalesce(new.replacement_for_hr_id, '')), '');
begin
  if new.seat_id is not null or v_predecessor is null then
    return new;
  end if;

  -- Their currently-held seat, but ONLY when they hold exactly one. A dual-seat holder (an
  -- acting DM keeps their own rep seat too) has no single "the" seat to hand over, and picking
  -- one by row order would hand the replacement an arbitrary seat. Exactly one, or nothing —
  -- the same rule the backfill and the hire tiers use. Deliberately NOT ordered by occupancy_id.
  select count(*), min(oh.seat_id)
    into v_open_seats, v_seat_id
    from au.occupancy_history oh
   where oh.occupant_canonical_hr_id = lower(v_predecessor)
     and oh.occupant_hr_id is not null
     and oh.effective_to is null;

  if v_open_seats <> 1 then
    v_seat_id := null;
  end if;

  -- Already departed: fall back to the sanctioned period-aware helper.
  if v_seat_id is null and v_open_seats = 0 then
    v_seat_id := au.f_last_occupied_seat_by_hr_id(v_predecessor);
  end if;

  -- Only claim the seat when no other open vacancy already recruits for it, so this can
  -- never trip the one-open-vacancy-per-seat index.
  if v_seat_id is not null and not exists (
    select 1 from public.position_vacancies pv
     where pv.seat_id = v_seat_id
       and lower(coalesce(pv.status, 'open')) = 'open'
       and pv.id is distinct from new.id
  ) then
    new.seat_id := v_seat_id;
  end if;

  return new;
end;
$function$;

revoke execute on function public.phx_stamp_vacancy_seat_from_predecessor() from public, anon, authenticated;
grant execute on function public.phx_stamp_vacancy_seat_from_predecessor() to service_role;

drop trigger if exists trg_position_vacancies_stamp_seat on public.position_vacancies;
create trigger trg_position_vacancies_stamp_seat
before insert on public.position_vacancies
for each row
execute function public.phx_stamp_vacancy_seat_from_predecessor();
