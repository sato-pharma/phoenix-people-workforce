-- WHAT: a vendor can be allowed or hidden from a screen (owner, 2026-11-03), and a vendor merged into
-- another can never be allowed by accident.
--
-- WHY. The pharmacy sync creates a new vendor hidden until he allows it, and 12 of the 22 vendors are
-- hidden today, yet allowing or hiding one was a database change. Two of the hidden vendors are not
-- merely hidden: Ibn Sina-Sato was merged into Ibn sina and EPDA-Pharmacies into epda. They hold 0 codes
-- because their codes were moved, and the Sales map still names them, so the sync's candidate view
-- holds their 5,520 codes as waiting. Allowing one would load those codes back under the old vendor on
-- the next run and undo the merge. Today nothing records that those two are different from the other
-- ten, so the column does.
--
-- Backfilled BY NAME because the ids differ between staging and production. The CHECK says a merged
-- vendor is never active, so the rule holds whatever writes the row.
--
-- phx_marketing_vendor_code_counts() is the count the screen needs and PostgREST cannot give: the
-- waiting codes are a NOT EXISTS over the sync's candidate view. Read-only, server-only.
--
-- ROLLBACK: drop the function, the constraint and the column. Nothing else reads them.

alter table public.marketing_distributors
  add column if not exists merged_into_distributor_id bigint
    references public.marketing_distributors(id) on delete set null;

update public.marketing_distributors retired
set merged_into_distributor_id = kept.id
from public.marketing_distributors kept
where (retired.normalized_name, kept.normalized_name) in (
    ('ibn sina-sato', 'ibn sina'),
    ('epda-pharmacies', 'epda')
  )
  and retired.merged_into_distributor_id is null;

alter table public.marketing_distributors
  drop constraint if exists marketing_distributors_merged_is_hidden_check;
alter table public.marketing_distributors
  add constraint marketing_distributors_merged_is_hidden_check check (
    merged_into_distributor_id is null
    or (merged_into_distributor_id <> id and active = false)
  );

comment on column public.marketing_distributors.merged_into_distributor_id is
  'Set when this vendor was folded into another. A merged vendor stays hidden: the Sales map still names '
  'it, so allowing it would load its codes back under the old name on the next sync and undo the merge.';

create or replace function public.phx_marketing_vendor_code_counts()
returns table (
  vendor_id        bigint,
  codes_loaded     bigint,
  codes_waiting    bigint,
  customers_linked bigint
)
language sql
stable
set search_path = public
set statement_timeout = '30s'
as $func$
  with loaded as (
    select r.distributor_id as id, count(*) as n
    from marketing_pharmacy_code_references r
    group by r.distributor_id
  ),
  waiting as (
    select c.distributor_id as id, count(*) as n
    from phx_v_sales_pharmacy_code_candidates c
    where not exists (
      select 1
      from marketing_pharmacy_code_references r
      where r.distributor_id = c.distributor_id
        and r.normalized_pharmacy_code = c.normalized_pharmacy_code
    )
    group by c.distributor_id
  ),
  linked as (
    select dc.distributor_id as id, count(distinct cp.customer_id) as n
    from marketing_customer_pharmacies cp
    join marketing_pharmacy_distributor_codes dc on dc.id = cp.distributor_code_id
    where cp.active
    group by dc.distributor_id
  )
  select
    d.id,
    coalesce(loaded.n, 0),
    coalesce(waiting.n, 0),
    coalesce(linked.n, 0)
  from marketing_distributors d
  left join loaded on loaded.id = d.id
  left join waiting on waiting.id = d.id
  left join linked on linked.id = d.id;
$func$;

comment on function public.phx_marketing_vendor_code_counts() is
  'For the Vendors panel on Marketing Control: per vendor, the pharmacy codes loaded, the codes the Sales '
  'map holds that are not loaded yet, and the customers with a live link through this vendor. Read-only.';

revoke all on function public.phx_marketing_vendor_code_counts() from public, anon, authenticated;
grant execute on function public.phx_marketing_vendor_code_counts() to service_role;
