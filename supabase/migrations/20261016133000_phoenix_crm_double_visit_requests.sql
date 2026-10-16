-- phoenix_crm_double_visit_requests
--
-- WHAT THIS CHANGES:
--   1. Two new tables:
--        public.phoenix_crm_double_visit_requests        — a rep's request, on the LAST question of a
--          visit to an AM or PM account: "do you need a double visit with this doctor/account?". It
--          carries up to three field days the rep can work, and which visit raised it;
--        public.phoenix_crm_double_visit_request_people — one row per person the rep asked (his
--          managers, the product managers of his line). Each answers on his own row: accepts ONE of the
--          days, or declines.
--   2. Three new functions, each under the request's own lock:
--        public.phoenix_crm_raise_double_visit_request(p jsonb)  — raised once per visit;
--        public.phoenix_crm_edit_double_visit_request_days(p jsonb) — the rep changes the days;
--        public.phoenix_crm_answer_double_visit_request(p jsonb)  — a person asked accepts or declines.
--      There is NO cancel function, deliberately.
--
-- WHY (owner, 2026-10-16):
--   "the last question while rep logging a visit to an am or pm account must be: do you need a double
--   visit with this dr/account? If yes show him manager and rsm if applicable and nsm and pm and gpm
--   if applicable, and then make him able to choose up to 3 timings, make him then able to edit the
--   timing but never cancel his request. After that a new sidebar report is generated for managers
--   which pumps notifications when they receive this request, and all managers must have access on
--   this report as per their scope up to the CEO." His answers to the three questions put to him:
--   any number of the people offered may be ticked, each answers on his own; a timing is a DAY only
--   (no clock time); the person asked accepts ONE day or declines, and the rep sees "Accepted, <day>"
--   or "Declined".
--
--   This is NOT the older visit ask (phoenix_crm_visit_asks, 2026-10-02), which asks ONE person and the
--   rep can take back. That table and its screens are untouched. A request here can never be taken
--   back: the rep edits its days, nothing more.
--
--   Editing the days, by rule (the application passes no judgement; the function holds it):
--     - a person who has not answered keeps waiting, and is asked again about the new days;
--     - a person who ACCEPTED a day still among the days keeps that answer;
--     - a person who ACCEPTED a day the rep has dropped goes back to waiting (the day he agreed to is gone);
--     - a person who DECLINED stays declined — a decline is an answer about the customer, not the day.
--
--   The functions never ask WHO the actor is beyond what the row proves — the application proves it from
--   the organogram and the row, and passes the people it resolved (who may be asked, which product
--   managers cover a line, which days are public holidays are the application's: the organogram, the
--   sales scope and the holiday calendar live outside this module's tables). What the database keeps for
--   itself: the customer is on the territory's list and AM or PM, one request per visit, the Cairo day,
--   at most three field days, never a Friday, and only the rep edits.
--
--   is_test is the module's test world, as on every Phoenix CRM table: the Super Admin trying the module
--   and a test account working as the person it mirrors write test rows only, and no real reader ever
--   reads one.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_answer_double_visit_request(jsonb);
--   drop function if exists public.phoenix_crm_edit_double_visit_request_days(jsonb);
--   drop function if exists public.phoenix_crm_raise_double_visit_request(jsonb);
--   drop table if exists public.phoenix_crm_double_visit_request_people;
--   drop table if exists public.phoenix_crm_double_visit_requests;
--   (Nothing else reads the tables. Dropping them loses the requests made since they went live.)
--
-- Verification after apply:
--   select relname, relrowsecurity from pg_class where relname like 'phoenix_crm_double_visit_request%' and relkind = 'r';  -- 2 rows, t
--   select proname, prosecdef from pg_proc where proname like 'phoenix_crm_%double_visit_request%';                       -- 3 rows, t
--   select has_function_privilege('anon', 'public.phoenix_crm_raise_double_visit_request(jsonb)', 'execute');           -- f
--   select has_table_privilege('authenticated', 'public.phoenix_crm_double_visit_requests', 'select');                  -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive: two new tables and three new functions, no existing row touched.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_double_visit_requests (
  id uuid primary key default gen_random_uuid(),
  -- The rep's territory, and its line when the request was raised.
  seat_id text not null,
  line_code text,
  -- A customer on the territory's list (validated, or carried over and waiting to be), AM or PM.
  customer_id uuid not null references public.phoenix_crm_customers (id),
  -- Upper case, as every hr id in the module is stored.
  rep_hr_id text not null,
  -- The visit whose last question raised it. Unique: a save sent twice raises it once.
  visit_id uuid,
  -- One to three field days, in the order the rep gave them (the earliest first).
  days date[] not null,
  edited_at timestamptz,
  edit_count integer not null default 0,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_double_visit_requests_rep check (rep_hr_id = upper(rep_hr_id)),
  constraint phoenix_crm_double_visit_requests_days check (
    cardinality(days) between 1 and 3
    and extract(isodow from days[1]) <> 5
    and (days[2] is null or extract(isodow from days[2]) <> 5)
    and (days[3] is null or extract(isodow from days[3]) <> 5)
  )
);

comment on table public.phoenix_crm_double_visit_requests is
  'A rep''s request for a double visit with an AM or PM account, raised by the last question of the visit (owner, 2026-10-16): up to three field days, any number of the people offered. It can be edited (the days) and never cancelled. Each person asked answers on his own row in phoenix_crm_double_visit_request_people. The rep reads his own; every manager reads the requests of the territories in his scope, and each person asked reads his own. It never reads or writes the district manager''s own double-visit plan.';

create unique index if not exists phoenix_crm_double_visit_requests_visit_uniq
  on public.phoenix_crm_double_visit_requests (visit_id)
  where visit_id is not null;
create index if not exists phoenix_crm_double_visit_requests_seat_idx
  on public.phoenix_crm_double_visit_requests (seat_id, is_test, created_at desc);
create index if not exists phoenix_crm_double_visit_requests_customer_idx
  on public.phoenix_crm_double_visit_requests (customer_id, is_test, created_at desc);

create table if not exists public.phoenix_crm_double_visit_request_people (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.phoenix_crm_double_visit_requests (id) on delete cascade,
  -- Who was asked, and in which capacity: a manager of the territory, or a product manager of its line.
  asked_hr_id text not null,
  role text not null,
  status text not null default 'waiting',
  -- The day he picked, once accepted: one of the request's days.
  visit_on date,
  answered_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_double_visit_request_people_asked check (asked_hr_id = upper(asked_hr_id)),
  constraint phoenix_crm_double_visit_request_people_role check (role in ('manager', 'product_manager')),
  constraint phoenix_crm_double_visit_request_people_status check (status in ('waiting', 'accepted', 'declined')),
  constraint phoenix_crm_double_visit_request_people_accepted check ((status = 'accepted') = (visit_on is not null)),
  constraint phoenix_crm_double_visit_request_people_answered check ((status = 'waiting') = (answered_at is null))
);

comment on table public.phoenix_crm_double_visit_request_people is
  'One person asked by a double-visit request, and his own answer: waiting, accepted with one of the request''s days, or declined (owner, 2026-10-16). Each answers independently.';

create unique index if not exists phoenix_crm_double_visit_request_people_uniq
  on public.phoenix_crm_double_visit_request_people (request_id, asked_hr_id);
create index if not exists phoenix_crm_double_visit_request_people_asked_idx
  on public.phoenix_crm_double_visit_request_people (asked_hr_id, is_test, status);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role (a member of it), so the grant that follows is mandatory. The
-- `drop policy if exists` keeps the file replayable.
alter table public.phoenix_crm_double_visit_requests enable row level security;
drop policy if exists phoenix_crm_double_visit_requests_service_role on public.phoenix_crm_double_visit_requests;
create policy phoenix_crm_double_visit_requests_service_role
  on public.phoenix_crm_double_visit_requests for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_double_visit_requests from public, anon, authenticated;
grant all on table public.phoenix_crm_double_visit_requests to service_role;

alter table public.phoenix_crm_double_visit_request_people enable row level security;
drop policy if exists phoenix_crm_double_visit_request_people_service_role on public.phoenix_crm_double_visit_request_people;
create policy phoenix_crm_double_visit_request_people_service_role
  on public.phoenix_crm_double_visit_request_people for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_double_visit_request_people from public, anon, authenticated;
grant all on table public.phoenix_crm_double_visit_request_people to service_role;

-- ── The rep asks (the last question of a visit) ────────────────────────────────────────────────
--
-- p: seat_id, line_code, customer_id, rep_hr_id, visit_id, days (['YYYY-MM-DD', ...], one to three),
--    people ([{hr_id, role}, ...], at least one), is_test
--
-- Answers the request and `created`: false when the visit already raised one (that request is its
-- answer, and nobody is told twice).
create or replace function public.phoenix_crm_raise_double_visit_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_visit_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_days date[];
  v_customer public.phoenix_crm_customers%rowtype;
  v_request public.phoenix_crm_double_visit_requests%rowtype;
  v_found boolean := false;
  v_created boolean := false;
  v_person jsonb;
  v_asked text;
  v_role text;
  v_day date;
begin
  if v_seat is null or v_customer_id is null or v_rep is null
     or jsonb_typeof(p -> 'days') is distinct from 'array'
     or jsonb_typeof(p -> 'people') is distinct from 'array'
     or jsonb_array_length(p -> 'people') = 0 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The days: one to three, each a field day from today to four weeks on, none twice, never a Friday.
  select coalesce(array_agg(d order by d), '{}'::date[]) into v_days
  from (select distinct (value #>> '{}')::date as d from jsonb_array_elements(p -> 'days')) days;
  if cardinality(v_days) < 1 or cardinality(v_days) > 3
     or cardinality(v_days) <> jsonb_array_length(p -> 'days') then
    raise exception 'phoenix_crm:double_visit_bad_days';
  end if;
  foreach v_day in array v_days loop
    if v_day < v_today or v_day > v_today + 27 or extract(isodow from v_day) = 5 then
      raise exception 'phoenix_crm:double_visit_bad_days';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:double_visit_request:' || v_seat || ':' || v_customer_id::text || ':' || v_is_test::text));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id and c.seat_id = v_seat and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;

  -- Once per visit: a save sent twice raises the request once.
  if v_visit_id is not null then
    select r.* into v_request
    from public.phoenix_crm_double_visit_requests r
    where r.visit_id = v_visit_id;
    v_found := found;
  end if;

  if not v_found then
    -- An AM or PM account on the list: validated, or carried over and waiting to be. A pharmacy is
    -- neither, and a customer in the Archive is not on the list.
    if v_customer.list_type not in ('AM', 'PM') or v_customer.status not in ('active', 'pending') then
      raise exception 'phoenix_crm:double_visit_not_requestable';
    end if;

    insert into public.phoenix_crm_double_visit_requests (seat_id, line_code, customer_id, rep_hr_id, visit_id, days, is_test)
    values (v_seat, v_line, v_customer_id, v_rep, v_visit_id, v_days, v_is_test)
    returning * into v_request;

    for v_person in select value from jsonb_array_elements(p -> 'people') loop
      v_asked := upper(nullif(trim(coalesce(v_person ->> 'hr_id', '')), ''));
      v_role := coalesce(v_person ->> 'role', '');
      -- Nobody asks himself, and every role is one the module knows.
      if v_asked is null or v_asked = v_rep or v_role not in ('manager', 'product_manager') then
        raise exception 'phoenix_crm:bad_input';
      end if;
      insert into public.phoenix_crm_double_visit_request_people (request_id, asked_hr_id, role, is_test)
      values (v_request.id, v_asked, v_role, v_is_test)
      on conflict (request_id, asked_hr_id) do nothing;
    end loop;
    v_created := true;
  end if;

  return jsonb_build_object(
    'id', v_request.id,
    'created', v_created,
    'seat_id', v_request.seat_id,
    'customer_name', v_customer.name,
    'customer_list_type', v_customer.list_type,
    'days', to_jsonb(v_request.days),
    'is_test', v_request.is_test,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'hr_id', q.asked_hr_id, 'role', q.role, 'status', q.status) order by q.created_at, q.asked_hr_id)
      from public.phoenix_crm_double_visit_request_people q
      where q.request_id = v_request.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.phoenix_crm_raise_double_visit_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_double_visit_request(jsonb) to service_role;

-- ── The rep edits the days (never cancels) ─────────────────────────────────────────────────────
--
-- p: request_id, seat_id, actor_hr_id, days, is_test
--
-- Only the rep who raised it. Answers `changed` and the people to ask again: those still waiting, and
-- those whose accepted day the rep dropped (they go back to waiting). Editing to the same days changes
-- nothing and asks nobody.
create or replace function public.phoenix_crm_edit_double_visit_request_days(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_days date[];
  v_request public.phoenix_crm_double_visit_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_changed boolean := false;
  v_day date;
begin
  if v_id is null or v_seat is null or v_actor is null
     or jsonb_typeof(p -> 'days') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce(array_agg(d order by d), '{}'::date[]) into v_days
  from (select distinct (value #>> '{}')::date as d from jsonb_array_elements(p -> 'days')) days;
  if cardinality(v_days) < 1 or cardinality(v_days) > 3
     or cardinality(v_days) <> jsonb_array_length(p -> 'days') then
    raise exception 'phoenix_crm:double_visit_bad_days';
  end if;
  foreach v_day in array v_days loop
    if v_day < v_today or v_day > v_today + 27 or extract(isodow from v_day) = 5 then
      raise exception 'phoenix_crm:double_visit_bad_days';
    end if;
  end loop;

  select r.* into v_request
  from public.phoenix_crm_double_visit_requests r
  where r.id = v_id and r.seat_id = v_seat and r.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:double_visit_not_found';
  end if;
  -- Only the rep who raised it edits it; the application proves who the actor is.
  if v_request.rep_hr_id <> v_actor then
    raise exception 'phoenix_crm:double_visit_not_yours';
  end if;

  if v_request.days is distinct from v_days then
    update public.phoenix_crm_double_visit_requests r
    set days = v_days, edited_at = now(), edit_count = r.edit_count + 1, updated_at = now()
    where r.id = v_request.id
    returning * into v_request;
    -- The day a person agreed to is gone: back to waiting, asked again about the new days.
    update public.phoenix_crm_double_visit_request_people q
    set status = 'waiting', visit_on = null, answered_at = null, updated_at = now()
    where q.request_id = v_request.id and q.status = 'accepted' and not (q.visit_on = any (v_days));
    v_changed := true;
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id;

  return jsonb_build_object(
    'id', v_request.id,
    'changed', v_changed,
    'seat_id', v_request.seat_id,
    'customer_name', v_customer.name,
    'customer_list_type', v_customer.list_type,
    'days', to_jsonb(v_request.days),
    'is_test', v_request.is_test,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'hr_id', q.asked_hr_id, 'role', q.role, 'status', q.status, 'visit_on', q.visit_on) order by q.created_at, q.asked_hr_id)
      from public.phoenix_crm_double_visit_request_people q
      where q.request_id = v_request.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.phoenix_crm_edit_double_visit_request_days(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_edit_double_visit_request_days(jsonb) to service_role;

-- ── A person asked answers ─────────────────────────────────────────────────────────────────────
--
-- p: request_id, actor_hr_id, decision ('accept' | 'decline'), visit_on (accept only), is_test
--
-- The actor is the person recorded on the row — the application proves who is calling, and the row
-- decides which person answers (never a name in the body). A person may change his answer, and the rep
-- is told each time (the application).
create or replace function public.phoenix_crm_answer_double_visit_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_day date := nullif(p ->> 'visit_on', '')::date;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_request public.phoenix_crm_double_visit_requests%rowtype;
  v_person public.phoenix_crm_double_visit_request_people%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
begin
  if v_id is null or v_actor is null or v_decision not in ('accept', 'decline') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_request
  from public.phoenix_crm_double_visit_requests r
  where r.id = v_id and r.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:double_visit_not_found';
  end if;

  select q.* into v_person
  from public.phoenix_crm_double_visit_request_people q
  where q.request_id = v_request.id and q.asked_hr_id = v_actor;
  if not found then
    raise exception 'phoenix_crm:double_visit_not_asked';
  end if;

  if v_decision = 'accept' then
    -- One of the days the rep gave, and one that has not passed.
    if v_day is null or not (v_day = any (v_request.days)) or v_day < v_today then
      raise exception 'phoenix_crm:double_visit_bad_day';
    end if;
    update public.phoenix_crm_double_visit_request_people q
    set status = 'accepted', visit_on = v_day, answered_at = now(), updated_at = now()
    where q.id = v_person.id
    returning * into v_person;
  else
    update public.phoenix_crm_double_visit_request_people q
    set status = 'declined', visit_on = null, answered_at = now(), updated_at = now()
    where q.id = v_person.id
    returning * into v_person;
  end if;

  update public.phoenix_crm_double_visit_requests r set updated_at = now() where r.id = v_request.id;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id;

  return jsonb_build_object(
    'id', v_request.id,
    'person_id', v_person.id,
    'status', v_person.status,
    'visit_on', v_person.visit_on,
    'seat_id', v_request.seat_id,
    'rep_hr_id', v_request.rep_hr_id,
    'customer_name', v_customer.name,
    'customer_list_type', v_customer.list_type,
    'is_test', v_request.is_test
  );
end;
$$;

revoke execute on function public.phoenix_crm_answer_double_visit_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_answer_double_visit_request(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
