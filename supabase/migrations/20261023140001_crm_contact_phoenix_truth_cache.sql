-- WHAT
--   Backs `crm_contact_phoenix_truth` with a trigger-maintained, indexed table.
--
--   The view keeps its NAME, its three columns, their types and `security_invoker = true`, so the
--   THREE doors that left-join it — crm_visits_unified, crm_checkins_unified and
--   crm_plan_entries_unified — are not edited by this migration at all. Nothing else reads it
--   (9 rewrite dependencies, all three doors; no TypeScript names it).
--
-- WHY
--   The view is `select distinct on (reference_contact_crm_id) ... from phoenix_crm_customers`, and a
--   join qual cannot be pushed into a `distinct on`: Postgres builds the WHOLE thing and hashes it on
--   every read of every door, however narrow the page. Measured on production, 23 October 2026:
--
--     the truth view alone                              3.9 ms,    240 blocks
--     one ordered first page over an 83-day window    2948.2 ms, 29,853 blocks
--     the same page with the truth join removed        115.8 ms, 11,774 blocks
--     the same page against an INDEXED truth table     109.3 ms, 11,771 blocks
--
--   So hashing 2,287 winners (chosen out of 20,774 customer rows) is 96% of that page's time. A
--   day-sliced page pays the same 240 blocks to decorate 27 rows. With a primary key on
--   contact_crm_id the planner looks up only the contacts actually on the page.
--
--   `distinct on` is NOT removable: `phoenix_crm_customers_reference_uidx` is unique per
--   (seat_id, reference_contact_crm_id, is_test), not per contact, and 2 references already have more
--   than one qualifying row (3,829 are duplicated across the whole table). The winner — active
--   first, then newest validated_at, then newest updated_at — is a real rule, so it keeps ONE body.
--
-- THE STALENESS WINDOW
--   `phoenix_crm_customers` is the ONLY input: every column the truth reads (name, speciality,
--   status, validated_at, updated_at, is_test, reference_contact_crm_id) lives on that one table. So
--   one row trigger on insert, update AND delete covers all of it, and a customer edit changes the
--   cache inside the writer's own transaction. An UPDATE recomputes the OLD reference as well as the
--   new one: a row moved to another contact otherwise leaves the old contact holding a name that no
--   longer wins. TRUNCATE fires no row trigger, so a statement trigger rebuilds on it.
--
--   `phoenix_crm_contact_truth_reconcile()` is therefore a SAFETY NET, not the staleness bound, and
--   runs every 15 minutes rather than every 5. It compares both directions, repairs and warns.
--
-- LOCKS
--   `create or replace view` takes ACCESS EXCLUSIVE on the view for the length of the statement —
--   microseconds — and the three doors recompile on next use. The backfill writes 2,287 rows into a
--   new table nothing reads yet. No existing table is rewritten and no index is built on
--   `phoenix_crm_customers`.
--
-- ROLLBACK
--   One statement puts every reader back on the live computation and leaves the table, the triggers
--   and the schedule in place doing no harm:
--
--     create or replace view public.crm_contact_phoenix_truth with (security_invoker = true) as
--       select c.contact_crm_id, c.name, c.speciality
--         from public.phoenix_crm_contact_truth_calc() c;
--
--   Drop the triggers, the cron job and the table afterwards if the revert is final. Reverting the
--   pull request does not reverse an applied migration — only another migration does.

-- 1. THE ONE BODY. The view's pre-migration query verbatim, plus one optional narrowing predicate so
--    the row trigger can recompute a single contact instead of all 2,287.
create or replace function public.phoenix_crm_contact_truth_calc(
  p_contact_crm_id bigint default null
)
 returns table(contact_crm_id bigint, name text, speciality text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select distinct on (c.reference_contact_crm_id)
         c.reference_contact_crm_id as contact_crm_id,
         nullif(btrim(c.name), '') as name,
         nullif(btrim(c.speciality), '') as speciality
    from public.phoenix_crm_customers c
   where c.reference_contact_crm_id is not null
     and c.validated_at is not null
     and not c.is_test
     and c.status = any (array['active', 'pending', 'dropped'])
     and (p_contact_crm_id is null or c.reference_contact_crm_id = p_contact_crm_id)
   order by c.reference_contact_crm_id, (c.status = 'active') desc, c.validated_at desc, c.updated_at desc
$function$;

revoke execute on function public.phoenix_crm_contact_truth_calc(bigint) from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_calc(bigint) to service_role;

-- 2. THE CACHE. One row per contact, keyed by what the doors join on.
create table if not exists public.crm_contact_phoenix_truth_cache (
  contact_crm_id bigint not null,
  name text,
  speciality text,
  refreshed_at timestamptz not null default now(),
  primary key (contact_crm_id)
);

alter table public.crm_contact_phoenix_truth_cache enable row level security;

grant select, insert, update, delete on table public.crm_contact_phoenix_truth_cache to service_role;
revoke all on table public.crm_contact_phoenix_truth_cache from anon, authenticated;

comment on table public.crm_contact_phoenix_truth_cache is
  'The Phoenix name and speciality that win for each contact. Maintained by triggers on phoenix_crm_customers through phoenix_crm_contact_truth_calc(), which holds the one definition of the winner. Read through the view crm_contact_phoenix_truth.';

-- 3. THE WRITE PATHS. Both recompute THROUGH _calc, which is what keeps one definition of the winner.
create or replace function public.phoenix_crm_contact_truth_rebuild()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  delete from public.crm_contact_phoenix_truth_cache c
   where not exists (
     select 1 from public.phoenix_crm_contact_truth_calc() f where f.contact_crm_id = c.contact_crm_id
   );

  insert into public.crm_contact_phoenix_truth_cache (contact_crm_id, name, speciality, refreshed_at)
  select f.contact_crm_id, f.name, f.speciality, now()
    from public.phoenix_crm_contact_truth_calc() f
      on conflict (contact_crm_id) do update
         set name = excluded.name, speciality = excluded.speciality, refreshed_at = excluded.refreshed_at;
end;
$function$;

revoke execute on function public.phoenix_crm_contact_truth_rebuild() from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_rebuild() to service_role;

create or replace function public.phoenix_crm_contact_truth_touch(p_contact_crm_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_contact_crm_id is null then
    return;
  end if;

  delete from public.crm_contact_phoenix_truth_cache where contact_crm_id = p_contact_crm_id;

  insert into public.crm_contact_phoenix_truth_cache (contact_crm_id, name, speciality, refreshed_at)
  select f.contact_crm_id, f.name, f.speciality, now()
    from public.phoenix_crm_contact_truth_calc(p_contact_crm_id) f
      on conflict (contact_crm_id) do update
         set name = excluded.name, speciality = excluded.speciality, refreshed_at = excluded.refreshed_at;
end;
$function$;

revoke execute on function public.phoenix_crm_contact_truth_touch(bigint) from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_touch(bigint) to service_role;

-- 4. THE TRIGGERS. One table feeds the truth, so one row trigger covers every input. The OLD
--    reference is recomputed as well as the new one.
create or replace function public.phoenix_crm_contact_truth_on_customer()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.phoenix_crm_contact_truth_touch(old.reference_contact_crm_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    perform public.phoenix_crm_contact_truth_touch(new.reference_contact_crm_id);
  end if;

  return null;
end;
$function$;

revoke execute on function public.phoenix_crm_contact_truth_on_customer() from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_on_customer() to service_role;

create or replace function public.phoenix_crm_contact_truth_on_truncate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  perform public.phoenix_crm_contact_truth_rebuild();
  return null;
end;
$function$;

revoke execute on function public.phoenix_crm_contact_truth_on_truncate() from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_on_truncate() to service_role;

drop trigger if exists phoenix_crm_contact_truth_customer on public.phoenix_crm_customers;
create trigger phoenix_crm_contact_truth_customer
  after insert or update or delete on public.phoenix_crm_customers
  for each row execute function public.phoenix_crm_contact_truth_on_customer();

drop trigger if exists phoenix_crm_contact_truth_customer_truncate on public.phoenix_crm_customers;
create trigger phoenix_crm_contact_truth_customer_truncate
  after truncate on public.phoenix_crm_customers
  for each statement execute function public.phoenix_crm_contact_truth_on_truncate();

-- 5. THE SAFETY NET. Every input is triggered, so this exists for the case nobody thought of — a
--    direct catalog edit, a restore, a trigger disabled by hand. It repairs and says so.
create or replace function public.phoenix_crm_contact_truth_reconcile()
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_differences bigint;
begin
  select count(*) into v_differences from (
    (
      select contact_crm_id, name, speciality from public.phoenix_crm_contact_truth_calc()
      except
      select contact_crm_id, name, speciality from public.crm_contact_phoenix_truth_cache
    )
    union all
    (
      select contact_crm_id, name, speciality from public.crm_contact_phoenix_truth_cache
      except
      select contact_crm_id, name, speciality from public.phoenix_crm_contact_truth_calc()
    )
  ) d;

  if v_differences > 0 then
    perform public.phoenix_crm_contact_truth_rebuild();
    raise warning 'crm_contact_phoenix_truth_cache was stale: % row(s) repaired', v_differences;
  end if;

  return v_differences;
end;
$function$;

revoke execute on function public.phoenix_crm_contact_truth_reconcile() from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_reconcile() to service_role;

-- 6. THE BACKFILL, and the guard that refuses to commit a cache that disagrees with the rule.
do $do$
declare
  v_differences bigint;
  v_rows bigint;
begin
  perform public.phoenix_crm_contact_truth_rebuild();

  select count(*) into v_differences from (
    (
      select contact_crm_id, name, speciality from public.phoenix_crm_contact_truth_calc()
      except
      select contact_crm_id, name, speciality from public.crm_contact_phoenix_truth_cache
    )
    union all
    (
      select contact_crm_id, name, speciality from public.crm_contact_phoenix_truth_cache
      except
      select contact_crm_id, name, speciality from public.phoenix_crm_contact_truth_calc()
    )
  ) d;

  if v_differences > 0 then
    raise exception 'crm_contact_phoenix_truth cache backfill disagrees with phoenix_crm_contact_truth_calc() on % row(s) — refusing to commit', v_differences;
  end if;

  select count(*) into v_rows from public.crm_contact_phoenix_truth_cache;
  raise notice 'crm_contact_phoenix_truth_cache backfilled: % row(s), 0 differences', v_rows;
end
$do$;

-- 7. THE VIEW: same name, same columns, same security_invoker — now a keyed lookup.
create or replace view public.crm_contact_phoenix_truth
  with (security_invoker = true) as
  select c.contact_crm_id, c.name, c.speciality
    from public.crm_contact_phoenix_truth_cache c;

revoke all on table public.crm_contact_phoenix_truth from anon, authenticated;

-- 8. THE SCHEDULE. Guarded so a project without pg_cron still applies this file.
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('phoenix-crm-contact-truth-reconcile')
      where exists (select 1 from cron.job where jobname = 'phoenix-crm-contact-truth-reconcile');

    perform cron.schedule(
      'phoenix-crm-contact-truth-reconcile',
      '*/15 * * * *',
      $cron$select public.phoenix_crm_contact_truth_reconcile();$cron$
    );
  else
    raise notice 'pg_cron is not installed here — the reconcile is not scheduled on this project';
  end if;
end
$do$;
