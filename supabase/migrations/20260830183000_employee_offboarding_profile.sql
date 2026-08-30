-- Offboarding profile — the statutory fields the three EXIT documents need, and nothing else.
--
-- WHAT THIS IS FOR. `employee_hiring_profile` (2026-08-22) holds what the employment contract and
-- social-insurance Form 1 ask for when somebody JOINS. Three more government documents are printed
-- when somebody LEAVES, and they are currently filled in by hand:
--
--   • نموذج ٦ — إخطار بإنتهاء اشتراك مؤمن عليه. The National Organization for Social Insurance's
--     notification that a subscription has ended. Two sides, printed as an original and two copies
--     (its own back-page instruction 1: "من أصل وصورتين").
--   • طلب استقالة — the Ministry of Labour resignation request under مادة 167 of Labour Law
--     14/2025.
--   • نموذج إنهاء علاقة العمل بالتوافق بين الطرفين — the Ministry of Labour mutual-termination
--     agreement, three pages.
--   • إخلاء طرف موظف / إخلاء طرف شركة — the clearance pair. Not a government form: these are Sato's
--     own instruments, and unlike the labour pair BOTH are signed. See the columns below.
--
-- THE LAST TWO ARE ALTERNATIVES, NEVER BOTH. Owner's instruction, 2026-08-30: "not the two should
-- be signed, either this or this". They assert incompatible facts — one says the employee asked to
-- leave, the other says both parties agreed — so `exit_route` records which was taken and a CHECK
-- constraint below refuses a row that claims both were signed.
--
-- WHY A SECOND SATELLITE TABLE AND NOT COLUMNS ON THE HIRING PROFILE. The two are captured months
-- or years apart, by different people, for different authorities, and an exit is not a certainty
-- when somebody is hired. Keeping them apart means an exit form can never silently rewrite a value
-- the signed contract was printed from. Everything below is additive, keyed on hr_id, and can be
-- dropped whole without a payroll consequence.
--
-- WHAT IS NOT DUPLICATED HERE. The identity and address these documents ask for is the SAME
-- identity and address Form 1 already captured, so it is read from `employee_hiring_profile` and
-- `employees` — one truth per value. The departure date is read from `employee_resignations`, with
-- an override column here for the case below.

create table if not exists public.employee_offboarding_profile (
  hr_id text primary key,

  -- ── Which Ministry of Labour route was taken ──────────────────────────────────────────────
  -- NULL until somebody decides. The value drives which of the two templates the screen offers to
  -- print, so an undecided exit prints Form 6 and waits rather than guessing a legal basis.
  exit_route text check (exit_route is null or exit_route in ('resignation', 'mutualTermination')),

  -- ── The dates the documents are built from ────────────────────────────────────────────────
  -- The last working day, and the single most consequential value on Form 6: the Authority
  -- calculates the final contribution from it and charges 20% per month of late filing.
  --
  -- WHY AN OVERRIDE EXISTS AT ALL. `employee_resignations` is the system's record of a departure,
  -- but the exit form that writes it copies ONE date into submitted_date, resignation_date,
  -- last_working_date and effective_date in nearly every row — so those four agreeing is not four
  -- confirmations, it is one value repeated. This column is where a human writes the date that is
  -- actually on the paper. NULL means "use the resignation record", which is the normal case.
  last_working_date date,
  -- When the mutual-termination agreement is signed. NOT the last working day: the parties sign on
  -- one date and service ends on another, and clause 3 of that agreement carries the second one.
  agreement_date date,

  -- ── Why the employment ended ──────────────────────────────────────────────────────────────
  -- سبب انتهاء الاشتراك in Arabic, printed on Form 6 and again on the resignation's "ونظراً لـ"
  -- rule. Free text because the resignation form prints its own menu of accepted reasons
  -- (ظروف خاصة / دواعي السفر / نقل محل اقامتي / أي سبب اخر) and the office accepts wording, not a
  -- code. Measured on production 2026-08-30: `employee_resignations.reason` is populated in 0 of 54
  -- rows, so there is nothing to migrate and nowhere else this could be read from.
  end_reason_ar text,
  -- The Authority's own numeric reason code — Form 6 prints ONE box for it, so it holds a digit.
  end_reason_code text,

  -- ── Who the resignation is addressed to ───────────────────────────────────────────────────
  -- Defaults in the application to the manager who signs the employment contract as الطرف الأول:
  -- the resignation is addressed to whoever can accept it, and that is the same person. Stored per
  -- employee only so a one-off exception does not need a settings change.
  addressee_name_ar text,
  addressee_title_ar text,

  -- ── Who signs for the employer on the mutual-termination agreement ────────────────────────
  employer_rep_name_ar text,
  employer_rep_title_ar text,

  -- ── What was actually signed, and when ────────────────────────────────────────────────────
  -- Dates, not timestamps: what is recorded is the date written on a piece of paper by a person,
  -- not the moment a button was clicked.
  form6_signed_date date,
  resignation_signed_date date,
  mutual_termination_signed_date date,
  -- The two clearance papers — إخلاء طرف. DELIBERATELY NOT CONSTRAINED AGAINST EACH OTHER, and the
  -- contrast with the pair above is the point: those two are alternatives, these two are
  -- complements. One certifies the employee is clear of the company and he keeps it; the other
  -- certifies the company is clear of him and the company files it. Each protects the party who
  -- does not keep it, so a departure needs both signed, not one of them.
  --
  -- They are normally signed days apart — the six departmental sign-offs must be complete before
  -- finance releases a final settlement, and the employee's release is signed when that settlement
  -- is actually handed over — so two separate dates, and the gap between them is what HR chases.
  clearance_employee_signed_date date,
  clearance_company_signed_date date,
  -- How many copies left the printer, and when — so a reprint is visible rather than silent.
  form6_printed_at timestamptz,
  resignation_printed_at timestamptz,
  mutual_termination_printed_at timestamptz,
  clearance_employee_printed_at timestamptz,
  clearance_company_printed_at timestamptz,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_hr_id text,

  -- THE OWNER'S RULE, ENFORCED IN THE DATABASE RATHER THAN ONLY IN THE UI. One exit form is signed,
  -- never two. A screen can be bypassed by an API call; this cannot. Recording neither is fine —
  -- that is simply an exit still in progress.
  constraint employee_offboarding_profile_one_signed_exit_form
    check (resignation_signed_date is null or mutual_termination_signed_date is null)
);

comment on table public.employee_offboarding_profile is
  'Statutory fields required to fill social-insurance Form 6 and the two Ministry of Labour exit templates, plus the dates those documents were signed. Satellite of employees; never read by payroll. The resignation and mutual-termination forms are alternatives — a CHECK constraint refuses a row claiming both were signed.';

comment on column public.employee_offboarding_profile.last_working_date is
  'Override for employee_resignations.last_working_date, which is one date copied into four columns. NULL means use the resignation record.';

create index if not exists employee_offboarding_profile_unsigned_idx
  on public.employee_offboarding_profile (hr_id)
  where form6_signed_date is null;

create or replace function public.set_employee_offboarding_profile_updated_at()
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

drop trigger if exists employee_offboarding_profile_touch_updated_at on public.employee_offboarding_profile;
create trigger employee_offboarding_profile_touch_updated_at
  before update on public.employee_offboarding_profile
  for each row
  execute function public.set_employee_offboarding_profile_updated_at();

alter table public.employee_offboarding_profile enable row level security;

-- No policy is created on purpose. Visibility in this application is application-scoped, not
-- RLS-scoped: every read path goes through the service-role client behind
-- assertPermission(ctx, 'employee_documents', ...). RLS on with no policy is therefore the correct
-- posture — it denies the anon and authenticated roles outright and leaves the server in control,
-- the same shape `employee_hiring_profile` and every other admin-only table here uses.
revoke all on public.employee_offboarding_profile from anon, authenticated;

-- ── The signed exit papers become tracked hiring documents ────────────────────────────────────
-- The checklist already carries the joining side, and it runs further than it looks: 'Social
-- insurance form' at 80, 'Signed employment contract' at 85, and 'Medical check' at 90. These five
-- start at 100 so one employee file shows both ends of the relationship in the order it happened.
--
-- 100, NOT 90 - MEASURED ON PRODUCTION 2026-08-30, BEFORE THIS WAS APPLIED. The obvious next slot
-- after 85 is already taken. display_order carries no unique constraint, so inserting Form 6 at 90
-- would not fail: it would tie with 'Medical check' and let a JOINING document sort into the middle
-- of the LEAVING block, in whatever order the query happened to return. A silent ordering bug on a
-- checklist is the kind nobody reports, because the list still looks like a list.
insert into public.hiring_document_definitions (name, description, display_order, is_active)
select v.name, v.description, v.display_order, true
from (values
  ('Signed social insurance Form 6',
   'Form 6 — إخطار بإنتهاء اشتراك مؤمن عليه, signed by the employee and the responsible manager (original and two copies, double-sided).',
   100),
  ('Signed resignation request',
   'Ministry of Labour طلب استقالة under Article 167 of Labour Law 14/2025. Alternative to the mutual-termination agreement — only one is ever signed.',
   101),
  ('Signed mutual termination agreement',
   'Ministry of Labour نموذج إنهاء علاقة العمل بالتوافق بين الطرفين. Alternative to the resignation request — only one is ever signed.',
   102),
  ('Signed employee clearance',
   'إخلاء طرف موظف — the company certifies the employee is clear, signed by six departments and stamped. The employee keeps the original; this is the file copy. Complement of the company clearance, not an alternative to it.',
   103),
  ('Signed company clearance',
   'إخلاء طرف شركة — the employee acknowledges his final settlement and releases the company. Filed in the personnel file. Complement of the employee clearance, not an alternative to it.',
   104)
) as v(name, description, display_order)
where not exists (
  select 1 from public.hiring_document_definitions d where lower(d.name) = lower(v.name)
);

-- ── Rollback ──────────────────────────────────────────────────────────────────────────────────
-- Everything above is additive and reversible. To undo:
--
--   drop table if exists public.employee_offboarding_profile;
--   drop function if exists public.set_employee_offboarding_profile_updated_at();
--   delete from public.hiring_document_definitions
--    where name in ('Signed social insurance Form 6', 'Signed resignation request',
--                   'Signed mutual termination agreement', 'Signed employee clearance',
--                   'Signed company clearance');
--
-- The delete is safe only while no employee has been marked against those definitions; if any has,
-- set is_active = false instead so the history survives.
