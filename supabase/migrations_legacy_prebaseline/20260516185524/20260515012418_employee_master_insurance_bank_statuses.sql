alter table public.employees
  add column if not exists has_bank_account text,
  add column if not exists medical_insurance_status text,
  add column if not exists social_insurance_status text;

comment on column public.employees.has_bank_account is
  'Employee Master Data flag indicating whether HR has a payroll bank account on file. Allowed values: yes, no.';

comment on column public.employees.medical_insurance_status is
  'Employee Master Data enrollment status for medical insurance. Allowed values: yes, no, pending.';

comment on column public.employees.social_insurance_status is
  'Employee Master Data enrollment status for social insurance. Allowed values: yes, no, pending.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'employees_has_bank_account_allowed_chk'
      and conrelid = 'public.employees'::regclass
  ) then
    alter table public.employees
      add constraint employees_has_bank_account_allowed_chk
      check (has_bank_account is null or has_bank_account in ('yes', 'no'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'employees_medical_insurance_status_allowed_chk'
      and conrelid = 'public.employees'::regclass
  ) then
    alter table public.employees
      add constraint employees_medical_insurance_status_allowed_chk
      check (medical_insurance_status is null or medical_insurance_status in ('yes', 'no', 'pending'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'employees_social_insurance_status_allowed_chk'
      and conrelid = 'public.employees'::regclass
  ) then
    alter table public.employees
      add constraint employees_social_insurance_status_allowed_chk
      check (social_insurance_status is null or social_insurance_status in ('yes', 'no', 'pending'));
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'bank_account'
  ) then
    update public.employees
    set has_bank_account = case
        when nullif(trim(bank_account), '') is not null then 'yes'
        else 'no'
      end
    where has_bank_account is null;
  else
    update public.employees
    set has_bank_account = 'no'
    where has_bank_account is null;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'medical_insurance_number'
  ) or exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'medical_insurance'
  ) then
    execute $sql$
      update public.employees
      set medical_insurance_status = 'yes'
      where medical_insurance_status is null
        and (
          coalesce(
            case
              when exists (
                select 1
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'employees'
                  and column_name = 'medical_insurance_number'
              ) then nullif(trim(medical_insurance_number), '')
              else null
            end,
            ''
          ) <> ''
          or (
            exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'employees'
                and column_name = 'medical_insurance'
            )
            and medical_insurance is not null
          )
        )
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'social_insurance_number'
  ) or exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'social_insurance'
  ) then
    execute $sql$
      update public.employees
      set social_insurance_status = 'yes'
      where social_insurance_status is null
        and (
          coalesce(
            case
              when exists (
                select 1
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'employees'
                  and column_name = 'social_insurance_number'
              ) then nullif(trim(social_insurance_number), '')
              else null
            end,
            ''
          ) <> ''
          or (
            exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'employees'
                and column_name = 'social_insurance'
            )
            and social_insurance is not null
          )
        )
    $sql$;
  end if;
end $$;
