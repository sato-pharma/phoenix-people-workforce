-- outstation_expense_requests.expense_type / .transportation_type — CHECK constraints.
--
-- Both columns are validated in the app: the POST admin route
-- (app/api/admin/outstation/manager-expenses/route.ts) and the PATCH admin route
-- (app/api/admin/outstation/manager-expenses/[id]/route.ts) now both route through
-- src/lib/outstation/manager-expense-input.ts, which restricts each column to the members of
-- OutstationExpenseType ("traveling" | "meeting" | "other") and OutstationTransportationType
-- ("car" | "train" | "bus" | "other"). Until this migration there was no database backstop behind
-- either: pg_constraint carried no check for expense_type, transportation_type, or status on this
-- table (confirmed against production, 2026-09-03), so any write path that skipped the app-level
-- check — as the PATCH route did, by spreading its request body straight into the update payload —
-- could write an arbitrary string into either column with no error at all.
--
-- That matters beyond a bad value sitting in a row: updateManagerExpenseAsAdmin branches the fuel
-- calculation on `transportationType === "car"` (src/lib/outstation/service.ts), so an unrecognised
-- mode silently zeroes the fuel line — the trip is paid less with nothing on screen saying why —
-- and normalizeExpenseType (src/lib/outstation/expense-taxonomy.ts) title-cases whatever it is
-- handed, so a junk value becomes its own bucket in the dashboard breakdowns, filters and exports.
--
-- Verified against both live projects before writing this, so it is not a guess: production
-- (ozucdzovmcqvepbozvqf) and staging (cifwmndunmlxjhyjugxa) each hold only the taxonomy values
-- above across every row (80 rows in production at the time of writing) — so adding NOT VALID is
-- unnecessary here; the constraint validates cleanly against the existing data.
--
-- expense_type stays nullable (it always has been, default 'traveling') — the CHECK allows NULL
-- and restricts only a non-null value, so nothing currently relying on the column's own default
-- changes behaviour. transportation_type is already NOT NULL with no default, so its CHECK simply
-- restricts the value.
--
-- Scoped to public.outstation_expense_requests only. The legacy public.outstation_expenses import
-- table (fed from free-text Excel columns via src/lib/outstation/expense-import.ts) carries a much
-- wider, messier set of transport/trip-type labels from the source workbooks and is out of scope —
-- constraining it would be a separate, much larger change.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'outstation_expense_requests_expense_type_check'
      and conrelid = 'public.outstation_expense_requests'::regclass
  ) then
    alter table public.outstation_expense_requests
      add constraint outstation_expense_requests_expense_type_check
      check (expense_type is null or expense_type in ('traveling', 'meeting', 'other'));
  end if;
end $$;

comment on constraint outstation_expense_requests_expense_type_check
  on public.outstation_expense_requests is
  'Mirrors OutstationExpenseType (src/lib/outstation/types.ts). Backstops the app-level check in '
  'src/lib/outstation/manager-expense-input.ts — a write path that skips it (as the manager-expenses '
  'PATCH route once did) now fails loud instead of silently mis-bucketing the row in every '
  'downstream breakdown, filter and export.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'outstation_expense_requests_transportation_type_check'
      and conrelid = 'public.outstation_expense_requests'::regclass
  ) then
    alter table public.outstation_expense_requests
      add constraint outstation_expense_requests_transportation_type_check
      check (transportation_type in ('car', 'train', 'bus', 'other'));
  end if;
end $$;

comment on constraint outstation_expense_requests_transportation_type_check
  on public.outstation_expense_requests is
  'Mirrors OutstationTransportationType (src/lib/outstation/types.ts). Backstops the app-level check '
  'in src/lib/outstation/manager-expense-input.ts — updateManagerExpenseAsAdmin branches the fuel '
  'calculation on transportation_type = ''car'', so an unrecognised value used to silently zero the '
  'fuel line instead of failing.';
