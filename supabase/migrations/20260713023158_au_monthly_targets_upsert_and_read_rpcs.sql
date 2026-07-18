-- Phase 6 input/read path. au is not PostgREST-exposed, so writes/reads go through public
-- service-role-only RPCs. Rows are pre-validated app-side (map-or-reject to the 42 areas + real
-- products + carries_target); the FKs (RESTRICT to au.canonical_areas/au.lines) are the DB backstop.

create or replace function public.phx_upsert_monthly_targets(
  p_rows jsonb,
  p_actor text default null,
  p_source text default 'upload'
) returns integer
language plpgsql security definer set search_path to 'au','public'
as $$
declare
  v_count integer;
begin
  insert into au.monthly_targets (period, line_code, area_code, product_code, target_units, target_value, source, created_by, updated_at)
  select r.period, r.line_code, r.area_code, r.product_code, r.target_units, r.target_value, p_source, p_actor, now()
  from jsonb_to_recordset(p_rows) as r(
    period text, line_code text, area_code text, product_code text, target_units numeric, target_value numeric
  )
  on conflict (period, line_code, area_code, product_code)
  do update set
    target_units = excluded.target_units,
    target_value = excluded.target_value,
    source       = excluded.source,
    created_by   = excluded.created_by,
    updated_at   = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.phx_monthly_targets(p_period text)
returns table (
  period text, line_code text, area_code text, product_code text,
  target_units numeric, target_value numeric, source text, created_by text, updated_at timestamptz
)
language sql stable security definer set search_path to 'au','public'
as $$
  select t.period, t.line_code, t.area_code, t.product_code,
         t.target_units, t.target_value, t.source, t.created_by, t.updated_at
  from au.monthly_targets t
  where t.period = p_period
  order by t.line_code, t.area_code, t.product_code;
$$;

revoke all on function public.phx_upsert_monthly_targets(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.phx_monthly_targets(text) from public, anon, authenticated;
grant execute on function public.phx_upsert_monthly_targets(jsonb, text, text) to service_role;
grant execute on function public.phx_monthly_targets(text) to service_role;
