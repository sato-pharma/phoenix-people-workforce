-- Medical insurance: who is on the group policy, who should be, what it costs, and what the insurer
-- billed (owner, 2026-11-04).
--
-- WHY NEW TABLES AND NOT THE COLUMNS ON `employees`. `employees.medical_insurance_status` is HR's own
-- yes/no word and stays exactly that; it is not touched here and nothing here writes it. A policy needs
-- what a yes/no cannot hold: a certificate number, a category, dates of cover, and the spouse and
-- children who are on the policy without being employees at all.
--
-- hr_id IS TEXT, NOT A FOREIGN KEY, and it is NULLABLE. Text for the reason `hiring_document_statuses`
-- gives: HR ids are edited by several paths, and a hard key here would make a rename fail in a module
-- that only records cover. Nullable because the insurer bills people Phoenix has no record of, and a
-- register that could not hold them could not say so.
--
-- ACCESS. RLS on with no policy and nothing granted but to the service role: every read and write goes
-- through the server behind assertPermission. Members are `medical_insurance`; invoices and everything
-- that carries an amount are `medical_insurance_invoices`, which the HR seats do not hold.

create table if not exists public.medical_insurance_policies (
  id uuid primary key default gen_random_uuid(),
  insurer text not null,
  policy_number text not null unique,
  group_code text,
  sub_office text,
  starts_on date not null,
  ends_on date not null,
  rate_card jsonb not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on > starts_on)
);

comment on table public.medical_insurance_policies is
  'A group medical policy and its rate card. The rate card is data, so next year''s renewal is a new row and not a code change.';

create table if not exists public.medical_insurance_members (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  -- The employee this cover belongs to. Empty on a person the insurer bills and Phoenix cannot find.
  hr_id text,
  -- Text: a joiner has none until the insurer issues one, and the insurer owns its format.
  certificate_number text,
  member_type text not null check (member_type in ('employee', 'spouse', 'child')),
  -- A spouse or child points at the employee whose certificate they sit under.
  principal_member_id uuid references public.medical_insurance_members (id) on delete restrict,
  full_name text not null,
  category text not null check (category in ('A', 'B', 'C')),
  coverage_starts_on date not null,
  coverage_ends_on date,
  end_reason text,
  -- Held for a spouse or child only, who have no Phoenix record to read them from. An employee's birth
  -- date and national ID stay on their employee record and are read from there.
  birth_date date,
  national_id text,
  gender text check (gender is null or gender in ('M', 'F')),
  notes text,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (coverage_ends_on is null or coverage_ends_on >= coverage_starts_on),
  check ((member_type = 'employee') = (principal_member_id is null))
);

comment on table public.medical_insurance_members is
  'Who is on the policy, with dates of cover. A row is ended, never deleted, so the register can always say who was covered on a given day.';

create index if not exists medical_insurance_members_policy_idx
  on public.medical_insurance_members (policy_id, coverage_starts_on);
create index if not exists medical_insurance_members_hr_idx
  on public.medical_insurance_members (hr_id) where hr_id is not null;
create index if not exists medical_insurance_members_principal_idx
  on public.medical_insurance_members (principal_member_id) where principal_member_id is not null;
-- One open row per employee per policy: a second would bill the same person twice on the plan.
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

create table if not exists public.medical_insurance_invoices (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  bill_number text not null unique,
  issued_on date,
  period_starts_on date not null,
  period_ends_on date not null,
  premium_total numeric(14, 2) not null,
  fees_total numeric(14, 2) not null,
  total_due numeric(14, 2) not null,
  storage_bucket text not null default 'medical-insurance',
  storage_path text not null unique,
  file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  -- What was read off the file, and the comparison against the plan as it stood at that moment. The
  -- comparison is a snapshot on purpose: the register keeps moving, and an invoice's answer must not
  -- change just because somebody joined afterwards. "Compare again" replaces it deliberately.
  parsed jsonb not null,
  comparison jsonb not null,
  compared_at timestamptz not null default now(),
  uploaded_by_hr_id text,
  uploaded_at timestamptz not null default now()
);

comment on table public.medical_insurance_invoices is
  'An invoice from the insurer: the file, what was read from it, and how it compared with the plan. Nothing here pays anything or writes to payroll.';

create index if not exists medical_insurance_invoices_policy_idx
  on public.medical_insurance_invoices (policy_id, period_starts_on desc);

create table if not exists public.medical_insurance_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.medical_insurance_invoices (id) on delete cascade,
  certificate_number text not null,
  member_name text not null,
  birth_date date,
  product_code text not null,
  plan_code text,
  cover_type text not null check (cover_type in ('MEM', 'SPO', 'CHD')),
  dependant_count integer,
  volume numeric(14, 2),
  adjustment numeric(14, 2) not null default 0,
  premium numeric(14, 2) not null
);

create index if not exists medical_insurance_invoice_lines_invoice_idx
  on public.medical_insurance_invoice_lines (invoice_id, certificate_number);

create table if not exists public.medical_insurance_documents (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  -- communication_tool and form are the seat's to open. policy and email carry amounts, and stay with
  -- whoever holds medical_insurance_invoices.
  kind text not null check (kind in ('communication_tool', 'form', 'policy', 'email')),
  title text not null,
  storage_bucket text not null default 'medical-insurance',
  storage_path text unique,
  file_name text,
  content_type text,
  size_bytes integer check (size_bytes is null or size_bytes > 0),
  -- An email pasted in rather than attached.
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
  'Communication tools, forms, the policy and emails with the insurer. Private bucket; read only through the server-side file route.';

create index if not exists medical_insurance_documents_policy_idx
  on public.medical_insurance_documents (policy_id, kind, uploaded_at desc);

alter table public.medical_insurance_policies enable row level security;
alter table public.medical_insurance_members enable row level security;
alter table public.medical_insurance_exceptions enable row level security;
alter table public.medical_insurance_invoices enable row level security;
alter table public.medical_insurance_invoice_lines enable row level security;
alter table public.medical_insurance_documents enable row level security;

revoke all on public.medical_insurance_policies from public, anon, authenticated;
revoke all on public.medical_insurance_members from public, anon, authenticated;
revoke all on public.medical_insurance_exceptions from public, anon, authenticated;
revoke all on public.medical_insurance_invoices from public, anon, authenticated;
revoke all on public.medical_insurance_invoice_lines from public, anon, authenticated;
revoke all on public.medical_insurance_documents from public, anon, authenticated;

grant all on public.medical_insurance_policies to service_role;
grant all on public.medical_insurance_members to service_role;
grant all on public.medical_insurance_exceptions to service_role;
grant all on public.medical_insurance_invoices to service_role;
grant all on public.medical_insurance_invoice_lines to service_role;
grant all on public.medical_insurance_documents to service_role;

-- The policy in force from 1 November 2026, with its rate card as the policy and the first invoice state
-- it: per person per quarter, fees on each product's premium. Members are not seeded here.
insert into public.medical_insurance_policies (insurer, policy_number, group_code, sub_office, starts_on, ends_on, rate_card)
values (
  'MetLife',
  '6489200000',
  '4892A',
  '001',
  '2026-11-01',
  '2027-11-03',
  '{
    "billingMonths": 3,
    "currency": "EGP",
    "sumInsured": 200000,
    "medicalPerPerson": { "A": 5365.25, "B": 1936.50, "C": 1907.00 },
    "employeeCoversPerPerson": { "AD": 29.00, "GTL": 112.00, "PPDA": 9.50, "PTD": 14.00 },
    "supervisoryFeeBasisPoints": 55,
    "stampBasisPoints": { "AD": 50, "CMM": 100, "GTL": 50, "PPDA": 50, "PTD": 50 },
    "issueFee": { "product": "GTL", "fee": 250.00, "nominalStamp": 100.00 }
  }'::jsonb
)
on conflict (policy_number) do nothing;

-- ── The bucket ────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'medical-insurance',
      'medical-insurance',
      -- Never public. An invoice names every employee and their date of birth.
      false,
      -- 25 MB. The insurer's communication-tools archive is about 7 MB and an email with its attachments
      -- can be several times that.
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
