do $$
begin
  if to_regclass('public.salary_flags') is not null then
    execute '
      alter table public.salary_flags
        add column if not exists resolved_at timestamptz,
        add column if not exists resolved_by text
    ';
    execute '
      create index if not exists idx_salary_flags_unresolved
        on public.salary_flags (resolved_at) where resolved_at is null
    ';
  end if;
end $$;
