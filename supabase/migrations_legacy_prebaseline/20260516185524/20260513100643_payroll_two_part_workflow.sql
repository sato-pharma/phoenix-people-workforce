do $$
begin
  if to_regclass('public.salary_batches') is null
     or to_regclass('public.salary_records') is null
     or to_regclass('public.salary_flags') is null then
    raise notice 'Skipping payroll_two_part_workflow because core payroll tables do not exist yet.';
    return;
  end if;
end $$;
