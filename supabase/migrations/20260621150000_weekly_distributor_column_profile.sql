-- Phase 6 Part B (Weekly Sales editable column profiles): a governed, DB-backed override of the
-- code-defined Weekly column contract (src/lib/sales/weekly/column-contract.ts). Each active row WHOLLY
-- overrides the code contract for ONE of the six known weekly distributors (EG/RM/IS/IS-S/SF/PS), so an
-- admin can fix a moved column in-app without a code deploy. The whole nested contract (per-sheet, per-
-- field column indices) is stored as a single jsonb document mirroring WeeklyContractSheet[] — it is read,
-- written and validated as one unit, never queried field-by-field across distributors.
--
-- resolveWeeklyContract() resolves DB-first (active=true) and falls back to the code contract, so this
-- table starts EMPTY and weekly parsing is byte-identical until an admin saves an edit. The parser keeps
-- the code contract as its compiled default; an unapplied migration here therefore degrades safely to
-- exactly the current behaviour. Additive + reversible. Service-role writes only; authenticated read of
-- active rows. RLS mirrors source_of_sales_distributor_profile (the monthly equivalent).
--
-- NOTE: weekly parsing semantics (Arabic prefix-stripping, signed sales, authoritative net, PS matrices)
-- are per-distributor adapter code — so this override edits the COLUMN POSITIONS of the six known
-- distributors only; it cannot onboard a brand-new weekly distributor (that still needs an adapter).

create table if not exists public.weekly_sales_distributor_column_profile (
  distributor_code text primary key,
  distributor_name text not null default '',
  split_files boolean not null default false,
  -- WeeklyContractSheet[] as authored in column-contract.ts: each element is
  -- { role, sheetName?, sheetIncludes?, headerRowNumber, formField, fields:[{field,label,columnIndex,
  --   expectedHeaderHint,role}], matrix? }. Stored whole; the store reconstructs the typed contract.
  sheets jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  updated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_sales_distributor_column_profile_code_not_blank check (btrim(distributor_code) <> ''),
  constraint weekly_sales_distributor_column_profile_sheets_is_array check (jsonb_typeof(sheets) = 'array')
);

alter table public.weekly_sales_distributor_column_profile enable row level security;

revoke all on table public.weekly_sales_distributor_column_profile from anon, authenticated;
grant select on table public.weekly_sales_distributor_column_profile to authenticated;
grant select, insert, update, delete on table public.weekly_sales_distributor_column_profile to service_role;

drop policy if exists weekly_sales_distributor_column_profile_authenticated_read on public.weekly_sales_distributor_column_profile;
create policy weekly_sales_distributor_column_profile_authenticated_read
on public.weekly_sales_distributor_column_profile
for select
to authenticated
using (active = true);

drop policy if exists weekly_sales_distributor_column_profile_service_role_all on public.weekly_sales_distributor_column_profile;
create policy weekly_sales_distributor_column_profile_service_role_all
on public.weekly_sales_distributor_column_profile
for all
to service_role
using (true)
with check (true);

comment on table public.weekly_sales_distributor_column_profile is
  'Phase 6B: governed DB override of the weekly column contract (per-distributor column positions). Empty = code contract. Service-role only.';
