-- marketing_customer_list_checks
--
-- WHAT THIS CHANGES:
--   * a new table, public.marketing_customer_list_checks: one row per marketing customer and line,
--     holding the answer to "is this customer on the rep's own Phoenix CRM list?" and, when a person
--     decided it, who decided and when.
--   * a new nullable column, public.marketing_customers.crm_list_source: who set crm_list_status.
--     'picked' = chosen from a rep's list at validation; 'typed' = typed by hand at validation;
--     'checked' = set by the list check, or by a person's decision on the list-check board.
--   * a backfill of that one column on the rows that already carry a crm_list_status (21 on
--     production when written): on_list -> picked, not_on_list -> typed. Nothing else on them moves.
-- WHY: owner, 2026-10-27 and 2026-11-03. Only customers validated after 2026-10-23 were ever compared
--   with a rep's list, and only by being picked. 94 of the 114 validated customers were never checked,
--   so "not on the list" could not be told apart from "nobody looked". The source column exists so the
--   check never overwrites a person's pick, and so the approval flag never says "typed by hand" about a
--   row nobody typed.
-- ROLLBACK:
--   drop table if exists public.marketing_customer_list_checks;
--   alter table public.marketing_customers drop column if exists crm_list_source;
--   This drops the decisions recorded on the board. The values the check later writes into
--   marketing_customers.crm_list_status and phoenix_crm_customer_id are a separate step
--   (scripts/marketing-list-check.ts --apply), with its own pre-image.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Additive: no existing column is rewritten.

begin;

alter table public.marketing_customers
  add column if not exists crm_list_source text
    constraint marketing_customers_crm_list_source_check
    check (crm_list_source is null or crm_list_source in ('picked', 'typed', 'checked'));

comment on column public.marketing_customers.crm_list_source is
  'Who set crm_list_status: picked = from a rep''s list at validation; typed = by hand at validation; checked = by the list check or a decision on its board. The check never overwrites picked.';

update public.marketing_customers
   set crm_list_source = case crm_list_status when 'on_list' then 'picked' when 'not_on_list' then 'typed' end
 where crm_list_status is not null
   and crm_list_source is null;

create table if not exists public.marketing_customer_list_checks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.marketing_customers(id) on delete cascade,
  -- NULL when the customer has no request and no line of his own: that row can only read 'check'.
  line_id bigint references public.lines(id),
  state text not null
    constraint marketing_customer_list_checks_state_check
    check (state in ('on_list', 'check', 'not_on_list', 'no_holder', 'left_list', 'no_location')),
  reason text not null,
  matched_crm_customer_id uuid references public.phoenix_crm_customers(id) on delete set null,
  matched_name text,
  seat_id text,
  list_type text
    constraint marketing_customer_list_checks_list_type_check
    check (list_type is null or list_type in ('AM', 'PM')),
  name_match text
    constraint marketing_customer_list_checks_name_match_check
    check (name_match is null or name_match in ('same', 'one_letter', 'part', 'none')),
  metres_apart integer,
  same_brick boolean,
  area_code text,
  area_name text,
  looks_like_nursery boolean not null default false,
  checked_at timestamptz not null default now(),
  left_list_at timestamptz,
  -- A person's answer. It beats every later re-check.
  decided_state text
    constraint marketing_customer_list_checks_decided_state_check
    check (decided_state is null or decided_state in ('on_list', 'not_on_list')),
  decided_by_hr_id text,
  decided_at timestamptz,
  decided_source text
    constraint marketing_customer_list_checks_decided_source_check
    check (decided_source is null or decided_source in ('board', 'owner_sheet_2026_10_27')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_customer_list_checks_customer_line_key unique nulls not distinct (customer_id, line_id),
  constraint marketing_customer_list_checks_decision_whole
    check ((decided_state is null) = (decided_at is null) and (decided_state is null) = (decided_source is null))
);

create index if not exists marketing_customer_list_checks_state_idx
  on public.marketing_customer_list_checks (state);
create index if not exists marketing_customer_list_checks_matched_idx
  on public.marketing_customer_list_checks (matched_crm_customer_id)
  where matched_crm_customer_id is not null;

comment on table public.marketing_customer_list_checks is
  'Is this marketing customer on the rep''s own Phoenix CRM list, per line (owner, 2026-10-27, 2026-11-03). It flags and never blocks a request. Written by src/lib/marketing-requests/crm-list-check.ts.';

alter table public.marketing_customer_list_checks enable row level security;

revoke all on table public.marketing_customer_list_checks from public, anon, authenticated;
grant all on table public.marketing_customer_list_checks to service_role;

commit;
