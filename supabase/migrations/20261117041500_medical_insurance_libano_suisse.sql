-- SAFE: creates six new tables, one private bucket and one storage policy, and seeds one policy row. It
-- drops no table, column or row and changes no existing row; the only drop is the storage policy's own
-- `drop policy if exists`, so a re-run replaces it instead of failing.
--
-- Medical insurance, rebuilt for Libano-Suisse Takaful Egypt (owner, 2026-11-17: "build the Libano-Suisse
-- medical insurance module"). The MetLife module and its tables were dropped on 2026-11-11
-- (20261111061213_retire_medical_insurance.sql, docs/medical-insurance-retired.md); the same table names are
-- free again and are reused, with the shapes Libano-Suisse's contract needs.
--
-- WHAT IS DIFFERENT FROM METLIFE.
--   * The premium is ANNUAL, per person, by plan (A, B, C) and five-year age band. So every member carries a
--     date of birth, spouses and children included, and the rate card is a table of bands, not one figure.
--   * There are no quarterly bills. One opening invoice covers the year; a joiner is charged and a leaver
--     refunded by the day to the policy's end (a joiner in the last quarter pays 25% of the year).
--   * The insurer's member file is their own "Output draft" sheet; its staff number ('34', '34-1', or a
--     Phoenix HR id) is kept on the member as `staff_number`.
--   * An invoice is recorded by hand against what the plan says it should be. Libano-Suisse's bill layout is
--     not known yet, so nothing parses it.
--
-- hr_id IS TEXT, NOT A FOREIGN KEY, and NULLABLE, for the reasons the MetLife migration gave
-- (20261104092817_medical_insurance.sql): HR ids are edited by several paths, and the insurer can carry a
-- person Phoenix has no record of.
--
-- ACCESS. RLS on, no policy, nothing granted but to the service role: every read and write goes through the
-- server behind assertPermission. Members are `medical_insurance`; every amount is
-- `medical_insurance_invoices`, which the HR seats do not hold.

create table if not exists public.medical_insurance_policies (
  id uuid primary key default gen_random_uuid(),
  insurer text not null,
  -- Libano-Suisse issues the number with the policy; until then the proposal stands in.
  policy_number text unique,
  proposal_code text,
  starts_on date not null,
  ends_on date not null,
  rate_card jsonb not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on > starts_on)
);

comment on table public.medical_insurance_policies is
  'A group medical policy and its rate card. The rate card is data, so a re-quote or next year''s renewal is an edit or a new row, never a code change.';

create table if not exists public.medical_insurance_members (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  -- The employee this cover belongs to (a family member carries their employee's). Empty when the insurer
  -- carries someone Phoenix cannot find.
  hr_id text,
  -- The insurer's own number for the person, once they issue one.
  certificate_number text,
  -- The staff number on the insurer's file: the old certificate number ('34', '34-1') or a Phoenix HR id.
  staff_number text,
  member_type text not null check (member_type in ('employee', 'spouse', 'child')),
  principal_member_id uuid references public.medical_insurance_members (id) on delete restrict,
  full_name text not null,
  -- The plan: A, B or C. Called category in the code, as it was under MetLife.
  category text not null check (category in ('A', 'B', 'C')),
  coverage_starts_on date not null,
  coverage_ends_on date,
  end_reason text,
  -- The premium is priced on age, so every member carries a birth date, employees included (an employee's
  -- record can be blank where the insurer's file is not).
  birth_date date,
  national_id text,
  gender text check (gender is null or gender in ('M', 'F')),
  phone text,
  notes text,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (coverage_ends_on is null or coverage_ends_on >= coverage_starts_on),
  check ((member_type = 'employee') = (principal_member_id is null))
);

comment on table public.medical_insurance_members is
  'Who is on the policy, with dates of cover and plan. A row is ended, never deleted, so the register can always say who was covered on a given day.';

create index if not exists medical_insurance_members_policy_idx
  on public.medical_insurance_members (policy_id, coverage_starts_on);
create index if not exists medical_insurance_members_hr_idx
  on public.medical_insurance_members (hr_id) where hr_id is not null;
create index if not exists medical_insurance_members_principal_idx
  on public.medical_insurance_members (principal_member_id) where principal_member_id is not null;
-- One open row per employee per policy: a second would charge the same person twice.
create unique index if not exists medical_insurance_members_one_open_employee
  on public.medical_insurance_members (policy_id, hr_id)
  where member_type = 'employee' and hr_id is not null and coverage_ends_on is null;

create table if not exists public.medical_insurance_exceptions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  hr_id text not null,
  -- keep_out: the rule says they belong and they stay off. keep_in: the rule says they go and they stay on.
  decision text not null check (decision in ('keep_out', 'keep_in')),
  reason text not null check (length(btrim(reason)) > 0),
  decided_by_hr_id text,
  decided_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_hr_id text
);

comment on table public.medical_insurance_exceptions is
  'An exception to the rule that everyone is covered from day one, with the reason and who decided it. Revoked, never deleted.';

create unique index if not exists medical_insurance_exceptions_one_live
  on public.medical_insurance_exceptions (policy_id, hr_id)
  where revoked_at is null;

create table if not exists public.medical_insurance_category_choices (
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  hr_id text not null,
  category text not null check (category in ('A', 'B', 'C')),
  decided_by_hr_id text,
  decided_at timestamptz not null default now(),
  primary key (policy_id, hr_id)
);

comment on table public.medical_insurance_category_choices is
  'The plan decided for an employee who is not on the policy yet, read by the additions file. One row per person per policy; a new decision replaces it.';

create table if not exists public.medical_insurance_invoices (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  invoice_number text not null unique,
  -- opening: the year's first bill. additions / deletions: an endorsement for people joining or leaving.
  kind text not null check (kind in ('opening', 'additions', 'deletions', 'other')),
  issued_on date,
  -- The movements the bill covers, by the day cover started or ended. Empty on an opening bill.
  covers_from date,
  covers_to date,
  -- Positive for a charge, negative for a credit note.
  total_due numeric(14, 2) not null,
  storage_bucket text not null default 'medical-insurance',
  storage_path text unique,
  file_name text,
  content_type text,
  size_bytes integer check (size_bytes is null or size_bytes > 0),
  -- What the plan said this bill should be, at the moment it was recorded. A snapshot on purpose: the
  -- register keeps moving, and an invoice's answer must not change because somebody joined afterwards.
  -- "Compare again" replaces it deliberately.
  comparison jsonb not null,
  compared_at timestamptz not null default now(),
  note text,
  recorded_by_hr_id text,
  recorded_at timestamptz not null default now(),
  check (covers_from is null or covers_to is null or covers_to >= covers_from)
);

comment on table public.medical_insurance_invoices is
  'A bill or credit note from the insurer, as recorded by hand, and how it compared with the plan. Nothing here pays anything or writes to payroll.';

create index if not exists medical_insurance_invoices_policy_idx
  on public.medical_insurance_invoices (policy_id, recorded_at desc);

create table if not exists public.medical_insurance_documents (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  -- communication_tool and form are the HR seats' to open. policy and email carry amounts, and stay with
  -- whoever holds medical_insurance_invoices.
  kind text not null check (kind in ('communication_tool', 'form', 'policy', 'email')),
  title text not null,
  storage_bucket text not null default 'medical-insurance',
  storage_path text unique,
  file_name text,
  content_type text,
  size_bytes integer check (size_bytes is null or size_bytes > 0),
  email_from text,
  email_to text,
  email_sent_on date,
  body text,
  note text,
  uploaded_by_hr_id text,
  uploaded_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_hr_id text,
  check (storage_path is not null or length(btrim(coalesce(body, ''))) > 0)
);

comment on table public.medical_insurance_documents is
  'The table of benefits, forms, the policy and emails with the insurer. Private bucket; read only through the server-side file route.';

create index if not exists medical_insurance_documents_policy_idx
  on public.medical_insurance_documents (policy_id, kind, uploaded_at desc);

alter table public.medical_insurance_policies enable row level security;
alter table public.medical_insurance_members enable row level security;
alter table public.medical_insurance_exceptions enable row level security;
alter table public.medical_insurance_category_choices enable row level security;
alter table public.medical_insurance_invoices enable row level security;
alter table public.medical_insurance_documents enable row level security;

revoke all on public.medical_insurance_policies from public, anon, authenticated;
revoke all on public.medical_insurance_members from public, anon, authenticated;
revoke all on public.medical_insurance_exceptions from public, anon, authenticated;
revoke all on public.medical_insurance_category_choices from public, anon, authenticated;
revoke all on public.medical_insurance_invoices from public, anon, authenticated;
revoke all on public.medical_insurance_documents from public, anon, authenticated;

grant all on public.medical_insurance_policies to service_role;
grant all on public.medical_insurance_members to service_role;
grant all on public.medical_insurance_exceptions to service_role;
grant all on public.medical_insurance_category_choices to service_role;
grant all on public.medical_insurance_invoices to service_role;
grant all on public.medical_insurance_documents to service_role;

-- The Libano-Suisse policy from 15 November 2026 (owner, 2026-11-17), with the rate card of the signed
-- renewal offer, proposal Rev 1.3 of 5 November 2026.
--
-- RATES. The offer prints each band's per-person premium rounded to the pound, and each band's total
-- exactly; four bands only reconcile at a fraction (Plan A 55-59: 4 x 30,865 = 123,460, printed 123,458).
-- So each rate here is the band total divided by its head count, and a band's total is rounded to the pound,
-- which reproduces every printed total and the offer's EGP 712,300. A band the offer did not quote is null:
-- nobody of that age and plan was in Sato's data, and it is priced only once Libano-Suisse quotes it (the
-- Cost tab edits the card).
insert into public.medical_insurance_policies (insurer, policy_number, proposal_code, starts_on, ends_on, rate_card, notes)
select
  'Libano-Suisse Takaful Egypt',
  null,
  'Rev 1.3',
  '2026-11-15',
  '2027-11-14',
  '{
    "currency": "EGP",
    "ageBands": [
      { "from": 0, "to": 17 }, { "from": 18, "to": 24 }, { "from": 25, "to": 29 }, { "from": 30, "to": 34 },
      { "from": 35, "to": 39 }, { "from": 40, "to": 44 }, { "from": 45, "to": 49 }, { "from": 50, "to": 54 },
      { "from": 55, "to": 59 }, { "from": 60, "to": 64 }, { "from": 65, "to": 69 }, { "from": 70, "to": 74 },
      { "from": 75, "to": 79 }, { "from": 80, "to": null }
    ],
    "plans": {
      "A": {
        "annualLimit": 150000, "network": "Full Network-004", "room": "Single room",
        "rates": [null, null, 9866, null, null, 17322, 21395, 23865, 30864.5, 38739, null, null, null, null]
      },
      "B": {
        "annualLimit": 75000, "network": "Full Network-003", "room": "Shared room",
        "rates": [null, null, null, 5733.5, 6921.75, 8079, 9923, 11041, null, null, null, null, null, null]
      },
      "C": {
        "annualLimit": 50000, "network": "Full Network-003", "room": "Shared room",
        "rates": [3113.3333, 3639.2174, 4281.25, 5208.6364, 6278.75, null, null, 9989, null, null, null, null, null, null]
      }
    },
    "taxBasisPoints": 155,
    "cardFeePerMember": 30,
    "issueFee": 90,
    "cardReissueFee": 30,
    "lastQuarterAdditionBasisPoints": 2500,
    "ageLimits": { "employee": 64, "spouse": 64, "child": 18 }
  }'::jsonb,
  'Signed table of benefits and renewal offer Rev 1.3, 5 November 2026. Offer: 104 people, EGP 712,300 before tax and fees.'
where not exists (select 1 from public.medical_insurance_policies where insurer = 'Libano-Suisse Takaful Egypt' and starts_on = '2026-11-15');

-- ── The bucket ────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'medical-insurance',
      'medical-insurance',
      -- Never public. A bill or a member file names every person with their date of birth.
      false,
      26214400,
      array[
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/zip',
        'application/x-zip-compressed',
        'message/rfc822',
        'application/vnd.ms-outlook'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists medical_insurance_service_role on storage.objects';
    execute $policy$
      create policy medical_insurance_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'medical-insurance')
      with check (bucket_id = 'medical-insurance')
    $policy$;
  end if;
end $$;

notify pgrst, 'reload schema';
