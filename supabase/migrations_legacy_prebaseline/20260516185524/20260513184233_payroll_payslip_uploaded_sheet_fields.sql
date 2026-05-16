do $$
begin
  if to_regclass('public.salary_records') is null then
    raise notice 'Skipping payroll_payslip_uploaded_sheet_fields because public.salary_records does not exist yet.';
    return;
  end if;
end $$;
