-- Hiring Pack — the statutory fields the employment contract and Form 1 need, and nothing else.
--
-- WHAT THIS IS FOR. A new hire is currently given two documents filled in BY HAND: the Sato Pharma
-- fixed-term employment contract (Labour Law 14/2025) and government Form 1 — نموذج ١، طلب اشتراك
-- مؤمن عليه, the National Organization for Social Insurance subscription request. Both are printed
-- blank and written on with a pen, which is where the transcription errors come from. This table
-- holds the handful of values those two documents ask for that Phoenix does not already know.
--
-- WHY A SATELLITE TABLE AND NOT COLUMNS ON `employees`. `employees` is the single most
-- load-bearing table in this system — payroll, attendance, incentives and the seat model all read
-- it. Fifteen new columns there is fifteen new ways to break a salary run for a feature that only
-- prints paper. Everything below is additive, keyed on hr_id, and can be dropped whole without a
-- payroll consequence. The fields Phoenix ALREADY holds (national_id, social_insurance_number,
-- name_ar, birth_date, residence_address, mobile_number, work_email, gross_salary,
-- social_insurance_wage, hire_date, job_title) are deliberately NOT duplicated here — the document
-- reads them from `employees` so there is exactly one truth per value.
--
-- COVERAGE MEASURED ON PRODUCTION 2026-08-22, 112 active employees: national_id 105, name_ar 108,
-- birth_date 106, social_insurance_number 105, social_insurance_wage 93, residence_address 104,
-- mobile_number 108, work_email 109, gross_salary 102, hire_date 110, job_title 112. So the
-- existing data carries most of both documents already; what is missing is what this table adds.

create table if not exists public.employee_hiring_profile (
  hr_id text primary key,

  -- ── Identity the two documents ask for and `employees` does not carry ──────────────────────
  -- Form 1 "الجنسية" and the contract's opening party block. Recruitment is Egyptian-nationals-only
  -- as a standing owner rule, so the app defaults this to مصري; the column stays free text because
  -- the rule is a hiring policy, not a database constraint, and a future exception must not need a
  -- migration.
  nationality text,
  -- Form 1 "المؤهل" and the contract's "المؤهل الدراسي".
  qualification text,
  -- The contract asks for "تاريخ ومحل الميلاد" — Phoenix has employees.birth_date but no PLACE.
  birth_place text,
  -- Form 1 prints in Arabic; employees.job_title is English ("Medical Rep"). Both documents need
  -- the Arabic form, and Form 1 additionally wants the government occupation code (كود المهنة),
  -- which the form prints as six boxes in two groups of three, and Phoenix has no source for.
  job_title_ar text,
  occupation_code text,
  -- The NOSI branch office this employee's file belongs to — printed on the Form 1 header
  -- ("مكتب ..............") and again on the back-page إقرار.
  insurance_office text,

  -- ── Address, split the way Form 1 demands ─────────────────────────────────────────────────
  -- `employees.residence_address` is one free-text line. Form 1 wants it decomposed across five
  -- separate fields, three of them fixed-width box grids. There is no reliable way to split an
  -- Egyptian address string into these, so they are captured once, by hand, at hiring time.
  address_building text,      -- عقـار رقــم
  address_district text,      -- شياخة / قرية
  address_street text,        -- شارع / حارة
  address_markaz text,        -- قسم / مركز
  address_governorate text,   -- محافظة

  -- ── Contract terms that are policy, not employee data ─────────────────────────────────────
  -- Four blanks in the contract are commercial terms rather than facts about the person. They
  -- default from system settings so HR types nothing in the normal case; a row here overrides the
  -- default for one specific hire (a senior joiner on different terms). NULL means "use the
  -- company default", which is why none of these carry a database default of their own.
  contract_duration_months integer check (contract_duration_months is null or contract_duration_months > 0),
  contract_start_date date,
  contract_end_date date,
  -- مادة (10): sustained achievement below this share of target, for this many consecutive months,
  -- is a lawful ground for non-renewal.
  underperformance_threshold_pct numeric(5, 2)
    check (underperformance_threshold_pct is null or (underperformance_threshold_pct > 0 and underperformance_threshold_pct <= 100)),
  underperformance_months integer check (underperformance_months is null or underperformance_months > 0),
  -- مادة (14): months of service owed after a company-funded course before the cost stops being
  -- recoverable.
  training_bond_months integer check (training_bond_months is null or training_bond_months > 0),

  -- ── What was actually signed, and when ────────────────────────────────────────────────────
  -- The owner's requirement in plain terms: after the pack is printed and signed, the system should
  -- record that this employee signed the contract and Form 1, and on what date. These two dates are
  -- that record. They are dates, not timestamps, because what is being recorded is the date written
  -- on a piece of paper by a person, not the moment a button was clicked.
  contract_signed_date date,
  form1_signed_date date,
  -- How many copies left the printer, and when. Form 1 is printed as an original plus two copies
  -- (its own back-page instruction 1: "من أصل وصورتين") and the contract in four (مادة ١٩: "حُرر
  -- هذا العقد من أربع نسخ"). Recorded so a reprint is visible rather than silent.
  contract_printed_at timestamptz,
  form1_printed_at timestamptz,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_hr_id text
);

comment on table public.employee_hiring_profile is
  'Statutory fields required to fill the employment contract and social-insurance Form 1, plus the dates those documents were signed. Satellite of employees; never read by payroll.';

create index if not exists employee_hiring_profile_unsigned_idx
  on public.employee_hiring_profile (hr_id)
  where contract_signed_date is null or form1_signed_date is null;

create or replace function public.set_employee_hiring_profile_updated_at()
returns trigger
language plpgsql
-- PARALLEL SAFE is a correctness declaration in this database, not a performance hint: a function
-- left UNSAFE by default silently disables parallel query for anything that touches it.
parallel safe
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists employee_hiring_profile_touch_updated_at on public.employee_hiring_profile;
create trigger employee_hiring_profile_touch_updated_at
  before update on public.employee_hiring_profile
  for each row
  execute function public.set_employee_hiring_profile_updated_at();

alter table public.employee_hiring_profile enable row level security;

-- No policy is created on purpose. Visibility in this application is application-scoped, not
-- RLS-scoped: every read path goes through the service-role client behind
-- assertPermission(ctx, 'employee_documents', ...). RLS on with no policy is therefore the correct
-- posture — it denies the anon and authenticated roles outright and leaves the server in control,
-- the same shape every other admin-only table here uses.
revoke all on public.employee_hiring_profile from anon, authenticated;

-- ── The signed contract becomes a tracked hiring document ─────────────────────────────────────
-- The checklist already carries "Social insurance form" (display_order 80), which is Form 1 itself.
-- It has no row for the contract, so signing one has never been visible on the tracker. Added at
-- 85 so the two documents this feature produces sit next to each other.
insert into public.hiring_document_definitions (name, description, display_order, is_active)
select 'Signed employment contract', 'Employment contract signed by the new hire (four copies, Labour Law 14/2025).', 85, true
where not exists (
  select 1 from public.hiring_document_definitions where lower(name) = lower('Signed employment contract')
);
