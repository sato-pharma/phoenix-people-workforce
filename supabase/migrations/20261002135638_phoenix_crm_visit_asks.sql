-- phoenix_crm_visit_asks
--
-- WHAT THIS CHANGES:
--   1. One new table, public.phoenix_crm_visit_asks — a rep's ask for a visit, to one customer of his
--      list, WITH somebody: a double visit with his manager ('double'), a visit with a product manager
--      he picks ('product_manager'), or a chain visit with his district manager and the manager above
--      ('chain'). It waits for the person asked, who accepts it with a day or declines it; the rep may
--      cancel one that is still waiting.
--   2. Three new functions, each under the ask's own lock:
--        public.phoenix_crm_raise_visit_ask(p jsonb)  — the rep asks: from the customer's page, or by
--          the visit next step "Arrange a double visit", which raises a double ask ONCE per visit;
--        public.phoenix_crm_answer_visit_ask(p jsonb) — the person asked accepts with one of the rep's
--          field days (today to four weeks on, never a Friday) or declines;
--        public.phoenix_crm_cancel_visit_ask(p jsonb) — the rep takes back an ask still waiting.
--
-- WHY (owner, 2026-10-02):
--   "Double-visit asks reach DM: when a rep picks 'Arrange a double visit' as a next step, his district
--   manager sees the doctor and date. Nothing reads it today." And, in his own words the same day:
--   "the medical rep can request a double visit with his manager / product manager / or request a
--   chain visit to a certain dr". His rulings: the product manager is one the rep picks from his line's
--   product managers; a chain visit is his district manager and the next manager up, and both are
--   told; once the person asked accepts and picks a day, the rep sees "accepted, Tue 6 Oct" on his
--   ask. The district manager's own double-visit plan stays hidden from the rep — this table is the
--   REP's request, and its status is his to see; it never reads or writes that plan.
--
--   The functions never ask WHO the actor is — the application proves that, from the organogram and
--   the row (only the person recorded as asked answers an ask), and passes the people it resolved.
--   Who is asked, which product managers cover a line, and which days are public holidays are the
--   application's too: the organogram, the sales scope and the holiday calendar live outside this
--   module's tables. What the database keeps for itself: the customer is on the territory's list, one
--   ask in play per territory, customer and kind, one ask per visit, the Cairo day, and the field days.
--
--   is_test is the module's test world, as on every Phoenix CRM table: the Super Admin trying the
--   module and a test account working as the person it mirrors write test rows only, and no real
--   reader ever reads one.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_cancel_visit_ask(jsonb);
--   drop function if exists public.phoenix_crm_answer_visit_ask(jsonb);
--   drop function if exists public.phoenix_crm_raise_visit_ask(jsonb);
--   drop table if exists public.phoenix_crm_visit_asks;
--   (Nothing else reads the table. Dropping it loses the asks made since it went live.)
--
-- Verification after apply:
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_visit_asks';                          -- t
--   select proname, prosecdef from pg_proc where proname like 'phoenix_crm_%_visit_ask';                    -- 3 rows, t
--   select has_function_privilege('anon', 'public.phoenix_crm_raise_visit_ask(jsonb)', 'execute');        -- f
--   select has_table_privilege('authenticated', 'public.phoenix_crm_visit_asks', 'select');               -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive: one new table and three new functions, no existing row touched.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_visit_asks (
  id uuid primary key default gen_random_uuid(),
  -- The rep's territory, and its line when the ask was raised.
  seat_id text not null,
  line_code text,
  -- A customer on the territory's list (validated, or carried over and waiting to be).
  customer_id uuid not null references public.phoenix_crm_customers (id),
  kind text not null,
  -- Who asked (the rep, or the Super Admin trying the module in the test world), who answers, and who
  -- is told: the manager above for a chain visit, the rep's district manager for a product manager's.
  -- Upper case, as every hr id in the module is stored.
  rep_hr_id text not null,
  asked_hr_id text not null,
  told_hr_id text,
  -- The day the rep would like, if he said one. A wish: the person asked picks the day.
  wished_on date,
  -- The visit whose next step raised it; null when it was asked from the customer's page.
  visit_id uuid,
  status text not null default 'waiting',
  -- The day the person asked picked, once accepted.
  visit_on date,
  answered_by_hr_id text,
  answered_at timestamptz,
  cancelled_by_hr_id text,
  cancelled_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_visit_asks_kind check (kind in ('double', 'product_manager', 'chain')),
  constraint phoenix_crm_visit_asks_status check (status in ('waiting', 'accepted', 'declined', 'cancelled')),
  -- A double visit tells nobody else; a chain visit always tells the manager above.
  constraint phoenix_crm_visit_asks_told check (
    case kind when 'double' then told_hr_id is null when 'chain' then told_hr_id is not null else true end
  ),
  constraint phoenix_crm_visit_asks_people check (
    rep_hr_id = upper(rep_hr_id)
    and asked_hr_id = upper(asked_hr_id)
    and asked_hr_id <> rep_hr_id
    and (told_hr_id is null or (told_hr_id = upper(told_hr_id) and told_hr_id <> rep_hr_id and told_hr_id <> asked_hr_id))
  ),
  constraint phoenix_crm_visit_asks_accepted check ((status = 'accepted') = (visit_on is not null)),
  constraint phoenix_crm_visit_asks_answered check (
    (status in ('accepted', 'declined')) = (answered_at is not null and answered_by_hr_id is not null)
  ),
  constraint phoenix_crm_visit_asks_cancelled check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by_hr_id is not null)),
  -- Never a Friday (calendar.ts planDayListTypes): not as the day picked, not as the day wished.
  constraint phoenix_crm_visit_asks_field_days check (
    (visit_on is null or extract(isodow from visit_on) <> 5) and (wished_on is null or extract(isodow from wished_on) <> 5)
  )
);

comment on table public.phoenix_crm_visit_asks is
  'A rep''s ask for a visit with somebody (owner, 2026-10-02): a double visit with his manager, a visit with a product manager he picks, or a chain visit with his district manager and the manager above. The person asked accepts it with a day or declines it; the rep may cancel one still waiting. The rep reads his own asks; the person asked and the person told read theirs; SFE and the Super Admin read them all. It never reads or writes the district manager''s own double-visit plan.';

-- One ask in play per territory, customer and kind, per world. The function also treats an ask
-- accepted for a day still to come as in play; this index is the backstop for the waiting ones.
create unique index if not exists phoenix_crm_visit_asks_waiting_uniq
  on public.phoenix_crm_visit_asks (seat_id, customer_id, kind, is_test)
  where status = 'waiting';
-- One ask per visit: the next step raises at most one, however often the save is sent again.
create unique index if not exists phoenix_crm_visit_asks_visit_uniq
  on public.phoenix_crm_visit_asks (visit_id)
  where visit_id is not null;
create index if not exists phoenix_crm_visit_asks_asked_idx
  on public.phoenix_crm_visit_asks (asked_hr_id, is_test, status);
create index if not exists phoenix_crm_visit_asks_told_idx
  on public.phoenix_crm_visit_asks (told_hr_id, is_test, status)
  where told_hr_id is not null;
create index if not exists phoenix_crm_visit_asks_customer_idx
  on public.phoenix_crm_visit_asks (seat_id, customer_id, is_test, created_at);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role (a member of it), so the grant that follows is mandatory. The
-- `drop policy if exists` keeps the file replayable.
alter table public.phoenix_crm_visit_asks enable row level security;
drop policy if exists phoenix_crm_visit_asks_service_role on public.phoenix_crm_visit_asks;
create policy phoenix_crm_visit_asks_service_role
  on public.phoenix_crm_visit_asks for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_asks from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_asks to service_role;

-- ── The rep asks ───────────────────────────────────────────────────────────────────────────────
--
-- p: seat_id, line_code, customer_id, kind, rep_hr_id, asked_hr_id, told_hr_id, wished_on,
--    visit_id (the visit whose next step raised it; null from the customer's page), is_test
--
-- Answers the ask and `created`: false when a visit's next step found one already in play (that ask
-- is its answer, and nobody is told twice). From the customer's page an ask already in play is refused.
create or replace function public.phoenix_crm_raise_visit_ask(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_kind text := coalesce(p ->> 'kind', '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_asked text := upper(nullif(trim(coalesce(p ->> 'asked_hr_id', '')), ''));
  v_told text := upper(nullif(trim(coalesce(p ->> 'told_hr_id', '')), ''));
  v_wished date := nullif(p ->> 'wished_on', '')::date;
  v_visit_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_customer public.phoenix_crm_customers%rowtype;
  v_ask public.phoenix_crm_visit_asks%rowtype;
  v_found boolean := false;
  v_created boolean := false;
begin
  if v_seat is null or v_customer_id is null or v_rep is null or v_asked is null
     or v_kind not in ('double', 'product_manager', 'chain') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- Nobody asks himself, and the people on one ask are three different people.
  if v_asked = v_rep or v_told = v_rep or v_told = v_asked
     or (v_kind = 'double' and v_told is not null) or (v_kind = 'chain' and v_told is null) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:visit_ask:' || v_seat || ':' || v_customer_id::text || ':' || v_kind || ':' || v_is_test::text)
  );

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id and c.seat_id = v_seat and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;

  -- Once per visit: a save sent twice raises the ask once.
  if v_visit_id is not null then
    select a.* into v_ask
    from public.phoenix_crm_visit_asks a
    where a.visit_id = v_visit_id;
    v_found := found;
  end if;

  if not v_found then
    -- A customer on the list: validated, or carried over and waiting to be. Never one waiting outside
    -- the list, and never one in the Archive.
    if v_customer.status not in ('active', 'pending') then
      raise exception 'phoenix_crm:visit_ask_not_on_list';
    end if;

    -- One ask in play per territory, customer and kind: waiting, or accepted for a day still to come.
    select a.* into v_ask
    from public.phoenix_crm_visit_asks a
    where a.seat_id = v_seat
      and a.customer_id = v_customer_id
      and a.kind = v_kind
      and a.is_test = v_is_test
      and (a.status = 'waiting' or (a.status = 'accepted' and a.visit_on >= v_today))
    order by a.created_at desc
    limit 1;
    v_found := found;
    -- From the customer's page that is a second press. From a visit's next step it is the answer.
    if v_found and v_visit_id is null then
      raise exception 'phoenix_crm:visit_ask_already_open';
    end if;
  end if;

  if not v_found then
    -- A wished day is a wish: one that cannot be a field day to come is dropped, never refused.
    if v_wished is not null and (v_wished < v_today or v_wished > v_today + 27 or extract(isodow from v_wished) = 5) then
      v_wished := null;
    end if;
    insert into public.phoenix_crm_visit_asks
      (seat_id, line_code, customer_id, kind, rep_hr_id, asked_hr_id, told_hr_id, wished_on, visit_id, is_test)
    values
      (v_seat, v_line, v_customer_id, v_kind, v_rep, v_asked, v_told, v_wished, v_visit_id, v_is_test)
    returning * into v_ask;
    v_created := true;
  end if;

  return jsonb_build_object(
    'id', v_ask.id,
    'kind', v_ask.kind,
    'status', v_ask.status,
    'asked_hr_id', v_ask.asked_hr_id,
    'told_hr_id', v_ask.told_hr_id,
    'wished_on', v_ask.wished_on,
    'visit_on', v_ask.visit_on,
    'created', v_created,
    'customer_name', v_customer.name,
    'customer_list_type', v_customer.list_type,
    'is_test', v_ask.is_test
  );
end;
$$;

revoke execute on function public.phoenix_crm_raise_visit_ask(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_visit_ask(jsonb) to service_role;

-- ── The person asked answers ───────────────────────────────────────────────────────────────────
--
-- p: ask_id, actor_hr_id, decision ('accept' | 'decline'), visit_on (accept only), is_test
create or replace function public.phoenix_crm_answer_visit_ask(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'ask_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_day date := nullif(p ->> 'visit_on', '')::date;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_ask public.phoenix_crm_visit_asks%rowtype;
  v_customer_name text;
begin
  if v_id is null or v_actor is null or v_decision not in ('accept', 'decline') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select a.* into v_ask
  from public.phoenix_crm_visit_asks a
  where a.id = v_id and a.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_ask_not_found';
  end if;
  if v_ask.status = 'cancelled' then
    raise exception 'phoenix_crm:visit_ask_cancelled';
  end if;
  if v_ask.status <> 'waiting' then
    raise exception 'phoenix_crm:visit_ask_answered';
  end if;

  if v_decision = 'accept' then
    -- One of the rep's field days: today or later, four weeks at most, never a Friday. A public
    -- holiday is the application's to refuse — the national calendar lives outside this module.
    if v_day is null or v_day < v_today or v_day > v_today + 27 or extract(isodow from v_day) = 5 then
      raise exception 'phoenix_crm:visit_ask_bad_day';
    end if;
    update public.phoenix_crm_visit_asks a
    set status = 'accepted',
        visit_on = v_day,
        answered_by_hr_id = v_actor,
        answered_at = now(),
        updated_at = now()
    where a.id = v_ask.id
    returning * into v_ask;
  else
    update public.phoenix_crm_visit_asks a
    set status = 'declined',
        answered_by_hr_id = v_actor,
        answered_at = now(),
        updated_at = now()
    where a.id = v_ask.id
    returning * into v_ask;
  end if;

  select c.name into v_customer_name
  from public.phoenix_crm_customers c
  where c.id = v_ask.customer_id;

  return jsonb_build_object(
    'id', v_ask.id,
    'kind', v_ask.kind,
    'status', v_ask.status,
    'seat_id', v_ask.seat_id,
    'rep_hr_id', v_ask.rep_hr_id,
    'asked_hr_id', v_ask.asked_hr_id,
    'told_hr_id', v_ask.told_hr_id,
    'visit_on', v_ask.visit_on,
    'customer_name', v_customer_name,
    'is_test', v_ask.is_test
  );
end;
$$;

revoke execute on function public.phoenix_crm_answer_visit_ask(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_answer_visit_ask(jsonb) to service_role;

-- ── The rep takes back an ask still waiting ────────────────────────────────────────────────────
--
-- p: ask_id, seat_id, actor_hr_id, is_test
--
-- An ask already cancelled answers as it stands (a second press changes nothing); one already
-- answered is refused — an accepted visit is the person asked's to keep.
create or replace function public.phoenix_crm_cancel_visit_ask(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'ask_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_ask public.phoenix_crm_visit_asks%rowtype;
begin
  if v_id is null or v_seat is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select a.* into v_ask
  from public.phoenix_crm_visit_asks a
  where a.id = v_id and a.seat_id = v_seat and a.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_ask_not_found';
  end if;
  if v_ask.status in ('accepted', 'declined') then
    raise exception 'phoenix_crm:visit_ask_answered';
  end if;

  if v_ask.status = 'waiting' then
    update public.phoenix_crm_visit_asks a
    set status = 'cancelled',
        cancelled_by_hr_id = v_actor,
        cancelled_at = now(),
        updated_at = now()
    where a.id = v_ask.id
    returning * into v_ask;
  end if;

  return jsonb_build_object(
    'id', v_ask.id,
    'kind', v_ask.kind,
    'status', v_ask.status,
    'seat_id', v_ask.seat_id,
    'customer_id', v_ask.customer_id,
    'is_test', v_ask.is_test
  );
end;
$$;

revoke execute on function public.phoenix_crm_cancel_visit_ask(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_cancel_visit_ask(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
