-- Ahmed Nashaat (B-175) runs Upper Egypt 2 on Anti Infective, but his employee record carried no
-- region_code at all and he holds no Anti Infective seat, so nothing in the system could say which
-- territory he manages.
--
-- That matters beyond tidiness: the Closing Matrix credits a Direct sale to the district manager
-- named in the upload sheet's D.S.M. column, resolved through the organogram seat first and the
-- employee's own region second. With neither present his Direct fell back to a pro-rata estimate —
-- 5,980 EGP in July 2026 alone, spread across UE-1 and UE-2 instead of landing on UE-2.
--
-- Owner-confirmed 2026-08-03, twice: first stating the D.S.M. rule, then correcting the two names
-- against the organogram (Nosiba Salah = UE-1, Ahmed Nashaat = UE-2).
--
-- NOT FIXED HERE, deliberately: SEAT-AIF-DM-UE-2 still shows VACANT while he actually runs it.
-- Seating him changes headcount and vacancy reporting, which is an HR decision rather than a data
-- repair. Once he is seated the seat path resolves him and this row becomes redundant but harmless.

begin;

create table au.bak_20260803_b175_region as
  select * from public.employees where hr_id = 'B-175';

do $$
begin
  if not exists (select 1 from public.employees where hr_id = 'B-175') then
    raise exception 'B-175 not found — nothing to correct';
  end if;
  -- Refuse to overwrite a territory somebody else set in the meantime.
  if (select region_code from public.employees where hr_id = 'B-175') is not null then
    raise exception 'B-175 already carries region_code % — review before overwriting',
      (select region_code from public.employees where hr_id = 'B-175');
  end if;
  if not exists (select 1 from public.source_of_sales_regions where region_code = 'UE-2') then
    raise exception 'UE-2 is not a known region';
  end if;
end $$;

update public.employees
   set region_code = 'UE-2'
 where hr_id = 'B-175';

do $$
declare v_region text;
begin
  select region_code into v_region from public.employees where hr_id = 'B-175';
  if v_region is distinct from 'UE-2' then
    raise exception 'B-175 region_code is % after the update, expected UE-2', v_region;
  end if;
end $$;

commit;
