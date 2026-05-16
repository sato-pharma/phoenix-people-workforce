-- Final follow-up for remaining Supabase performance advisor FK warnings.
-- Bootstrap-safe version.

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'area_id') then
    execute 'create index if not exists positions_area_id_idx on public.positions (area_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'line_id') then
    execute 'create index if not exists positions_line_id_idx on public.positions (line_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_roles' and column_name = 'role_id') then
    execute 'create index if not exists user_roles_role_id_idx on public.user_roles (role_id)';
  end if;
end $$;
