-- drop_line_month_targets_with_archive
--
-- WHAT THIS CHANGES: adds au.monthly_targets_dropped (an archive of every target a Super Admin drops)
--   and public.phx_drop_monthly_targets(period, line, actor), a service-role-only RPC that copies one
--   line's targets for one month into that archive and then deletes them from au.monthly_targets, in
--   one transaction. Adds no data and deletes none by itself — only a call to the RPC does.
-- WHY: the Targets screen can overwrite a target but never remove a month's worth. The owner asked for
--   a Super Admin-only "drop this month" for a line. au.monthly_targets keeps no history (an
--   overwritten or deleted target is unrecoverable), so the drop archives first and a mistaken drop
--   can be put back by hand from the archive.
-- ROLLBACK: drop function public.phx_drop_monthly_targets(text, text, text);
--   then drop the archive table au.monthly_targets_dropped (the archive is the only recovery for a
--   dropped month, so drop it only once nothing has been dropped). Rows already dropped are restored
--   by inserting them back from the archive.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists au.monthly_targets_dropped (
  id            uuid primary key default gen_random_uuid(),
  drop_batch_id uuid not null,
  dropped_at    timestamptz not null default now(),
  dropped_by    text,
  period        text not null,
  line_code     text not null,
  area_code     text not null,
  product_code  text not null,
  target_units  numeric,
  target_value  numeric,
  source        text,
  created_by    text,
  created_at    timestamptz,
  updated_at    timestamptz
);

create index if not exists idx_monthly_targets_dropped_period
  on au.monthly_targets_dropped (period, line_code);

-- Same defence as au.monthly_targets: RLS on with no policy, so only the owner and service_role
-- (which bypass RLS) can touch it. au is not PostgREST-exposed.
alter table au.monthly_targets_dropped enable row level security;

create or replace function public.phx_drop_monthly_targets(
  p_period text,
  p_line_code text,
  p_actor text default null
) returns integer
language plpgsql security definer set search_path to 'au','public'
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_count integer;
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_drop_monthly_targets: invalid period %', p_period;
  end if;
  if p_line_code is null or btrim(p_line_code) = '' then
    raise exception 'phx_drop_monthly_targets: line is required';
  end if;

  -- Archive first, delete second, both in this one statement's transaction: a row is never deleted
  -- without its copy existing.
  insert into au.monthly_targets_dropped (
    drop_batch_id, dropped_by, period, line_code, area_code, product_code,
    target_units, target_value, source, created_by, created_at, updated_at
  )
  select v_batch, p_actor, t.period, t.line_code, t.area_code, t.product_code,
         t.target_units, t.target_value, t.source, t.created_by, t.created_at, t.updated_at
  from au.monthly_targets t
  where t.period = p_period and t.line_code = p_line_code;

  delete from au.monthly_targets t
  where t.period = p_period and t.line_code = p_line_code;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.phx_drop_monthly_targets(text, text, text) from public, anon, authenticated;
grant execute on function public.phx_drop_monthly_targets(text, text, text) to service_role;

commit;
