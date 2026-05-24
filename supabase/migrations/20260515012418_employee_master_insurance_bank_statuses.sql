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
declare
  has_bank_account_column boolean;
  has_medical_insurance_number_column boolean;
  has_medical_insurance_column boolean;
  has_social_insurance_number_column boolean;
  has_social_insurance_column boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'bank_account'
  ) into has_bank_account_column;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'medical_insurance_number'
  ) into has_medical_insurance_number_column;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'medical_insurance'
  ) into has_medical_insurance_column;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'social_insurance_number'
  ) into has_social_insurance_number_column;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employees'
      and column_name = 'social_insurance'
  ) into has_social_insurance_column;

  if has_bank_account_column then
    execute $sql$
      update public.employees
      set has_bank_account = case
          when nullif(trim(bank_account), '') is not null then 'yes'
          else 'no'
        end
      where has_bank_account is null
    $sql$;
  else
    update public.employees
    set has_bank_account = 'no'
    where has_bank_account is null;
  end if;

  if has_medical_insurance_number_column or has_medical_insurance_column then
    execute format(
      $sql$
        update public.employees
        set medical_insurance_status = 'yes'
        where medical_insurance_status is null
          and (%s)
      $sql$,
      array_to_string(
        array_remove(
          array[
            case
              when has_medical_insurance_number_column
                then 'nullif(trim(medical_insurance_number), '''') is not null'
              else null
            end,
            case
              when has_medical_insurance_column
                then 'medical_insurance is not null'
              else null
            end
          ],
          null
        ),
        ' or '
      )
    );
  end if;

  if has_social_insurance_number_column or has_social_insurance_column then
    execute format(
      $sql$
        update public.employees
        set social_insurance_status = 'yes'
        where social_insurance_status is null
          and (%s)
      $sql$,
      array_to_string(
        array_remove(
          array[
            case
              when has_social_insurance_number_column
                then 'nullif(trim(social_insurance_number), '''') is not null'
              else null
            end,
            case
              when has_social_insurance_column
                then 'social_insurance is not null'
              else null
            end
          ],
          null
        ),
        ' or '
      )
    );
  end if;
end $$;
