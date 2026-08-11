-- HR_ID canonicalisation as DATA, and a normalised requester key on direct orders.
--
-- WHY. Direct-order scope tiers (own / hierarchy) currently filter in JavaScript, comparing
-- `canonicalHrIdKey(row.requesterHrId)` against `canonicalHrIdKey(viewer)`. That means
-- getDirectOrderReport must select EVERY request before it can decide which ones the viewer may
-- see, so the Orders list cannot be paginated in the database — the filter happens after the read.
--
-- Translating that filter to SQL naively is WRONG and silently loses rows: `canonicalHrIdKey` is
-- not just lower(trim(...)), it also routes through an alias table —
--
--     hrIdAliases = { aaa: "aa" }   // legacy uploads used AAA for Dr Anwar; the master uses AA
--
-- so `.eq("requester_hr_id", hrId)` or `.in(...)` against canonical keys would drop Dr Anwar's
-- legacy rows from a scoped list with no error and nothing on screen to say the list is short.
--
-- WHY A LOOKUP TABLE AND NOT A CASE IN A GENERATED COLUMN (owner decision, 2026-08-11). Freezing
-- `{aaa: "aa"}` into a generated column's expression puts application data into the schema: adding
-- an alias later would need a migration AND a backfill, and until both landed SQL and TypeScript
-- would disagree silently. A table makes adding an alias an INSERT.
--
-- WHY A TRIGGER AND NOT `generated always as`. A STORED generated column must be IMMUTABLE and
-- cannot run a subquery, so it cannot consult this table at all. The key is therefore maintained by
-- a trigger on insert/update. The cost is that changing an alias requires re-running the backfill
-- at the bottom of this file for the affected rows — see phx_backfill_direct_order_requester_key().

begin;

-- ── The alias table ─────────────────────────────────────────────────────────
-- Both columns hold the ALREADY-lowercased form, matching canonicalHrIdKey's own ordering
-- (trim → lower → alias lookup). Storing mixed case here would make the lookup miss.
create table if not exists public.hr_id_aliases (
  alias      text primary key,
  canonical  text not null,
  reason     text,
  created_at timestamptz not null default now(),
  constraint hr_id_aliases_alias_is_lower check (alias = lower(btrim(alias))),
  constraint hr_id_aliases_canonical_is_lower check (canonical = lower(btrim(canonical))),
  -- An alias pointing at itself is a no-op that would only confuse a reader.
  constraint hr_id_aliases_not_self check (alias <> canonical)
);

comment on table public.hr_id_aliases is
  'HR_ID canonicalisation pairs. Mirrors hrIdAliases in src/lib/hr-id.ts — the two MUST agree, or '
  'SQL-side and JS-side scope filters return different rows. Adding a pair requires re-running '
  'phx_backfill_direct_order_requester_key().';

insert into public.hr_id_aliases (alias, canonical, reason)
values ('aaa', 'aa', 'Legacy uploads used AAA for Dr Anwar; the live employee master uses AA.')
on conflict (alias) do nothing;

-- ── The canonicaliser ───────────────────────────────────────────────────────
-- Deliberately mirrors canonicalHrIdKey exactly: trim, lower, then alias. Returns NULL for blank,
-- as the TypeScript does, so a missing HR ID never collapses into a match on empty string.
create or replace function public.phx_canonical_hr_id(p_value text)
returns text
language sql
stable
as $$
  select coalesce(
    (select a.canonical
       from public.hr_id_aliases a
      where a.alias = nullif(lower(btrim(p_value)), '')),
    nullif(lower(btrim(p_value)), '')
  );
$$;

-- ── The normalised key on direct orders ─────────────────────────────────────
alter table public.direct_order_requests
  add column if not exists requester_hr_id_key text;

comment on column public.direct_order_requests.requester_hr_id_key is
  'canonicalHrIdKey(requester_hr_id), maintained by trigger. Exists so own/hierarchy scope can '
  'filter in SQL and the Orders list can be paginated in the database rather than in JavaScript.';

create or replace function public.phx_direct_order_set_requester_key()
returns trigger
language plpgsql
as $$
begin
  new.requester_hr_id_key := public.phx_canonical_hr_id(new.requester_hr_id);
  return new;
end;
$$;

drop trigger if exists trg_direct_order_requester_key on public.direct_order_requests;
create trigger trg_direct_order_requester_key
  before insert or update of requester_hr_id
  on public.direct_order_requests
  for each row
  execute function public.phx_direct_order_set_requester_key();

-- ── Backfill ────────────────────────────────────────────────────────────────
-- A function rather than a bare UPDATE so it can be re-run after an alias is added, which the
-- trigger alone does not handle (an alias change does not touch the rows it now affects).
create or replace function public.phx_backfill_direct_order_requester_key()
returns bigint
language plpgsql
as $$
declare
  v_rows bigint;
begin
  update public.direct_order_requests
     set requester_hr_id_key = public.phx_canonical_hr_id(requester_hr_id)
   where requester_hr_id_key is distinct from public.phx_canonical_hr_id(requester_hr_id);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

select public.phx_backfill_direct_order_requester_key();

-- Partial: a null key means no requester to scope by, and those rows are never the target of an
-- own/hierarchy filter.
create index if not exists direct_order_requests_requester_key_idx
  on public.direct_order_requests (requester_hr_id_key)
  where requester_hr_id_key is not null;

-- Service-role only, consistent with every other object in this module (RLS enabled, no policies).
revoke all on function public.phx_canonical_hr_id(text) from public;
revoke all on function public.phx_backfill_direct_order_requester_key() from public;
grant execute on function public.phx_canonical_hr_id(text) to service_role;
grant execute on function public.phx_backfill_direct_order_requester_key() to service_role;

alter table public.hr_id_aliases enable row level security;

notify pgrst, 'reload schema';

commit;
