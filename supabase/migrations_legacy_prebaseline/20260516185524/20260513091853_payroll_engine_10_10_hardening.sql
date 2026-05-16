do $$
begin
  if to_regclass('public.salary_batches') is null
     or to_regclass('public.salary_records') is null
     or to_regclass('public.salary_flags') is null then
    raise notice 'Skipping payroll_engine_10_10_hardening because core payroll tables do not exist yet.';
    return;
  end if;

  if exists (
    select 1
    from public.salary_batches
    group by year, month
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce unique payroll periods while duplicate salary_batches rows exist. Resolve duplicates manually before applying payroll hardening.' using errcode = '23505';
  end if;
end $$;
