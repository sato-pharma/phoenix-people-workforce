-- Every excuse and every vacation carries a short human-readable code.
--
-- Owner request, 2026-09-10: "I want every excuse and every vacation in the system in Phoenix
-- historical and upcoming to have a unique code to be able to identify it easier than this" —
-- "this" being the uuid primary key, which nobody can read out over the phone.
--
-- Shape is EXC-0001 / VAC-0001: sequence-backed, never reused, never reset. The DEFAULT lives on
-- the column rather than in the service layer on purpose — a code assigned in TypeScript is a code
-- a direct SQL insert or a future writer can forget, and a leave row with no code is exactly the
-- thing this migration exists to remove.
--
-- Four digits is not a ceiling: lpad pads, it never truncates, so row 10000 reads EXC-10000 and
-- stays unique. At the current rate (27 excuses since June, 547 vacations since January) that is
-- roughly eight years away.

-- ---------------------------------------------------------------------------
-- Excuses
-- ---------------------------------------------------------------------------
create sequence if not exists public.v2_excuse_request_code_seq as bigint;

alter table public.v2_excuse_requests
  add column if not exists request_code text;

-- Backfill oldest-first so the number tracks the order requests were actually submitted.
-- id is the tiebreaker: two rows created in the same microsecond must still get a stable order,
-- or a re-run of this block could hand them different numbers.
with ordered as (
  select id, row_number() over (order by created_at, id) as rn
  from public.v2_excuse_requests
  where request_code is null
)
update public.v2_excuse_requests as r
   set request_code = 'EXC-' || lpad(ordered.rn::text, 4, '0')
  from ordered
 where ordered.id = r.id;

-- Park the sequence past the backfill. The third argument is is_called: on an empty table we must
-- pass false, or the first real insert would skip EXC-0001.
select setval(
  'public.v2_excuse_request_code_seq',
  greatest((select count(*) from public.v2_excuse_requests), 1),
  (select count(*) > 0 from public.v2_excuse_requests)
);

alter table public.v2_excuse_requests
  alter column request_code
  set default 'EXC-' || lpad(nextval('public.v2_excuse_request_code_seq')::text, 4, '0');

alter sequence public.v2_excuse_request_code_seq
  owned by public.v2_excuse_requests.request_code;

create unique index if not exists v2_excuse_requests_request_code_key
  on public.v2_excuse_requests (request_code);

alter table public.v2_excuse_requests
  alter column request_code set not null;

-- ---------------------------------------------------------------------------
-- Vacations
-- ---------------------------------------------------------------------------
create sequence if not exists public.v2_vacation_request_code_seq as bigint;

alter table public.v2_vacation_requests
  add column if not exists request_code text;

with ordered as (
  select id, row_number() over (order by created_at, id) as rn
  from public.v2_vacation_requests
  where request_code is null
)
update public.v2_vacation_requests as r
   set request_code = 'VAC-' || lpad(ordered.rn::text, 4, '0')
  from ordered
 where ordered.id = r.id;

select setval(
  'public.v2_vacation_request_code_seq',
  greatest((select count(*) from public.v2_vacation_requests), 1),
  (select count(*) > 0 from public.v2_vacation_requests)
);

alter table public.v2_vacation_requests
  alter column request_code
  set default 'VAC-' || lpad(nextval('public.v2_vacation_request_code_seq')::text, 4, '0');

alter sequence public.v2_vacation_request_code_seq
  owned by public.v2_vacation_requests.request_code;

create unique index if not exists v2_vacation_requests_request_code_key
  on public.v2_vacation_requests (request_code);

alter table public.v2_vacation_requests
  alter column request_code set not null;

-- ---------------------------------------------------------------------------
-- The code is an identifier, so it does not move once assigned.
-- ---------------------------------------------------------------------------
-- Without this a writer that spreads a whole row object back over the record (the common Supabase
-- update shape) can silently renumber a request, and every screen, email and printout that already
-- quoted the old code would then point at nothing.
create or replace function public.v2_freeze_request_code()
returns trigger
language plpgsql
as $$
begin
  if old.request_code is not null and new.request_code is distinct from old.request_code then
    raise exception
      'request_code is immutable: % cannot become %', old.request_code, new.request_code
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists v2_excuse_requests_freeze_request_code on public.v2_excuse_requests;
create trigger v2_excuse_requests_freeze_request_code
  before update on public.v2_excuse_requests
  for each row execute function public.v2_freeze_request_code();

drop trigger if exists v2_vacation_requests_freeze_request_code on public.v2_vacation_requests;
create trigger v2_vacation_requests_freeze_request_code
  before update on public.v2_vacation_requests
  for each row execute function public.v2_freeze_request_code();
