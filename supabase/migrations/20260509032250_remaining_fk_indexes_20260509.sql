-- Final follow-up for remaining Supabase performance advisor FK warnings.
-- These are true missing covering indexes and are safe to add.
-- The accompanying unused-index warnings are intentionally not auto-pruned here;
-- they need workload evidence before removal.

do $$
declare
  idx record;
begin
  for idx in
    select *
    from (
      values
        ('positions', 'area_id', 'positions_area_id_idx'),
        ('positions', 'line_id', 'positions_line_id_idx'),
        ('user_roles', 'role_id', 'user_roles_role_id_idx')
    ) as t(table_name, column_name, index_name)
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = idx.table_name
        and column_name = idx.column_name
    ) then
      execute format(
        'create index if not exists %I on public.%I (%I)',
        idx.index_name,
        idx.table_name,
        idx.column_name
      );
    end if;
  end loop;
end $$;
