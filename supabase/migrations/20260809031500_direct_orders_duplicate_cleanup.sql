-- Direct Orders — duplicate pharmacy merge + duplicate request cancellation (owner rules 1-5, 2026-08-09)
--
-- WHAT HAPPENED. A District Manager registered one pharmacy twice: on 2026-08-06 with the
-- distributor's customer code typed into the NAME box (DOP-000017, name "1573270"), and on
-- 2026-08-07 correctly (DOP-000021, "محمود احمد صالح", code PS/0001573270 in its own column). She
-- also submitted the SAME order on each — LA001, 240 units, 25% discount, collection 2026-09-11,
-- 59,400 EGP. Nothing in the system noticed either duplication. 59,400 EGP stood in the system
-- twice, one copy already climbing the approval chain.
--
-- The owner's instruction: the system already proves the two records are one pharmacy, so it should
-- merge them and cancel the duplicate order rather than hand the mistake back to the employee — with
-- an SFE Manager reviewing and confirming the cleanup before anything is written.
--
-- This migration adds the two columns that make such a cleanup ACCOUNTABLE rather than silent, and
-- one action so a duplicate can be cancelled from wherever it currently sits.
--
-- NO NEW STATUSES, ON PURPOSE. `cancelled` and all four source statuses are already declared. The
-- 2026-08-05 outage — every direct_orders transition dead, reps unable to raise an order at all —
-- happened because an action referenced an UNDECLARED status: normalizeActions() throws,
-- listWorkflowRegistryModules() catches, logs, and SKIPS the whole module. This file therefore
-- cannot reproduce that failure, and a later edit must not add a status here. The loader simulation
-- at the end still runs, because the guarantee should be enforced rather than trusted.

begin;

-- 1. The permanent link from a cancelled duplicate to the copy that survived.
--
--    Without it "cancelled" is just a dead end, and the next person to ask "why was this cancelled?"
--    has to reconstruct the answer from audit prose. With it the pair stays navigable forever, which
--    is what makes cancelling safe: nothing is lost, one copy simply points at the other.
alter table public.direct_order_requests
  add column if not exists duplicate_of_request_id uuid;

alter table public.direct_order_requests
  drop constraint if exists direct_order_requests_duplicate_of_fkey;

alter table public.direct_order_requests
  add constraint direct_order_requests_duplicate_of_fkey
  foreign key (duplicate_of_request_id) references public.direct_order_requests(id) on delete set null;

-- A request can never be its own duplicate, and the keeper must not itself point anywhere.
alter table public.direct_order_requests
  drop constraint if exists direct_order_requests_duplicate_not_self_check;

alter table public.direct_order_requests
  add constraint direct_order_requests_duplicate_not_self_check
  check (duplicate_of_request_id is null or duplicate_of_request_id <> id);

create index if not exists direct_order_requests_duplicate_of_idx
  on public.direct_order_requests (duplicate_of_request_id)
  where duplicate_of_request_id is not null;

comment on column public.direct_order_requests.duplicate_of_request_id is
  'The surviving request this one duplicates. Set only when a request is cancelled as a duplicate, '
  'and it points at the copy that was KEPT — so the pair stays navigable and no order is ever '
  'silently lost. NULL for every request that is not a duplicate, which is almost all of them.';

-- 2. The merge trail on the pharmacy side. Same reasoning: a deactivated duplicate must say what it
--    became, or its Phoenix code (quoted in old reports and emails) resolves to a dead record.
alter table public.direct_order_pharmacies
  add column if not exists merged_into_pharmacy_id uuid,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_by_hr_id text;

alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_merged_into_fkey;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_merged_into_fkey
  foreign key (merged_into_pharmacy_id) references public.direct_order_pharmacies(id) on delete set null;

alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_merged_not_self_check;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_merged_not_self_check
  check (merged_into_pharmacy_id is null or merged_into_pharmacy_id <> id);

create index if not exists direct_order_pharmacies_merged_into_idx
  on public.direct_order_pharmacies (merged_into_pharmacy_id)
  where merged_into_pharmacy_id is not null;

comment on column public.direct_order_pharmacies.merged_into_pharmacy_id is
  'The surviving pharmacy this duplicate record was folded into. Its requests were moved there and '
  'this row deactivated. Identity is proven by a shared distributor customer code — never by a '
  'similar name, which is typed by hand in two languages and is not evidence of anything.';

-- 3. EXACTLY ONE update to the registry row — two updates would be two version bumps for one change.
--
--    cancel_duplicate is a separate action from cancel_held on purpose, for the same reason
--    release_held was not folded into revive_held: cancel_held's audit line says the REQUESTER
--    withdrew the request. Nobody withdrew this one. The system found a duplicate and an SFE Manager
--    confirmed it — different authority, different audit line, different word.
--
--    `from` covers every open status because a duplicate can be found wherever it happens to sit;
--    all four are already declared. `approved` is deliberately excluded: an approved order is money
--    committed and, once a sales month is set, injected into Source of Sales. Undoing that is a
--    REVERSAL, which has its own action and its own re-approval.
--
--    Roles are Super Admin + SFE Manager, matching release_held — the owner's rule 5 puts SFE in the
--    reviewer's seat for this cleanup.
update public.workflow_registry_modules
set actions = actions || jsonb_build_array(
      jsonb_build_object(
        'key', 'cancel_duplicate',
        'label', 'Cancelled as a duplicate of another request, confirmed by an SFE Manager',
        'from', jsonb_build_array('draft', 'held', 'pending_approval', 'returned'),
        'to', 'cancelled',
        'auditLog', 'Direct order cancelled as a confirmed duplicate, linked to the request that was kept',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('close request', 'record duplicate_of_request_id'),
        'notifications', jsonb_build_array('notify requester + CC'),
        'tests', jsonb_build_array('a cancelled duplicate points at its keeper and an approved order can never be cancelled this way'),
        'allowedRoles', jsonb_build_array('Super Admin', 'SFE Manager')
      )
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(actions) a where a->>'key' = 'cancel_duplicate'
  );

-- `version` is deliberately NOT set. workflow_registry_modules_touch is a BEFORE UPDATE trigger that
-- already bumps it; setting it explicitly is what moved the row 5 -> 7 instead of 5 -> 6 on
-- 2026-08-05. The counts are the real check: 9 statuses (unchanged) and 15 actions after this.

-- 4. Simulate the loader before committing — the check whose absence cost the outage.
do $$
declare
  bad text;
begin
  select string_agg(distinct problem, ', ')
    into bad
  from (
    select format('action %s -> undeclared target %L', a->>'key', a->>'to') as problem
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a
    where m.module_key = 'direct_orders'
      and not exists (
        select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = a->>'to'
      )
    union all
    select format('action %s <- undeclared source %L', a->>'key', f.value)
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a,
         jsonb_array_elements_text(a->'from') f(value)
    where m.module_key = 'direct_orders'
      and not exists (
        select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = f.value
      )
    union all
    select format('action %s is missing a required %L', a->>'key', field)
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a,
         unnest(array['key', 'label', 'to', 'auditLog']) as field
    where m.module_key = 'direct_orders'
      and coalesce(nullif(trim(a->>field), ''), null) is null
  ) problems;

  if bad is not null then
    raise exception 'direct_orders registry would be SKIPPED by the loader: %', bad;
  end if;
end $$;

commit;
