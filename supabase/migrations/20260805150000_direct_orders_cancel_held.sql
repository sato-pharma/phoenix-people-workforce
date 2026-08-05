-- Direct Orders — cancel_held (deep workflow audit, finding F3)
--
-- Until now the ONLY exits from `held` were `revive_held` (the pharmacy passed validation) and
-- `expire_held` (the 14-day sweep). Nothing let the person who raised a duplicate withdraw it.
--
-- That is not hypothetical. On 2026-08-04 a District Manager submitted the same order twice, 22
-- minutes apart — byte-identical product, quantity, deal, discount and value — because the first
-- attempt could not find a valid pharmacy code. The first sat `held` with no exit but the 14-day
-- clock, and retiring it on 2026-08-05 required raw SQL against production, which bypassed the
-- registry precisely because the registry had no vocabulary for it. A retry that leaves a permanent
-- duplicate behind is a normal, repeatable user action; it will happen again.
--
-- `cancelled` is a NEW status rather than a reuse of `rejected`. A withdrawn duplicate is not an
-- approver's rejection. Counting it as one would inflate every rejection rate, the per-rep counters
-- and the #BYSTATUS summary on the live sheet — making a rep who tidied up after themselves look
-- like someone whose orders keep getting turned down.
--
-- Both halves are in ONE transaction on purpose. Declaring an action whose target status is not
-- declared is exactly what caused the 2026-08-05 outage: normalizeActions() validates each action's
-- `to` AND every entry in its `from` against the declared status keys and THROWS;
-- listWorkflowRegistryModules() catches that, logs it, and SKIPS the module; every direct_orders
-- transition then reports "module is missing or inactive" — including plain `submit`, which has
-- nothing to do with held orders. Reps could not raise a direct order at all. A half-applied
-- version of this migration would reproduce that outage exactly, so it must not be splittable.

begin;

alter table public.direct_order_requests
  drop constraint if exists direct_order_requests_status_check;

alter table public.direct_order_requests
  add constraint direct_order_requests_status_check
  check (status = any (array[
    'draft'::text,
    'pending_approval'::text,
    'approved'::text,
    'rejected'::text,
    'returned'::text,
    'reversed'::text,
    'held'::text,
    'expired'::text,
    'cancelled'::text
  ]));

-- Append-only and guarded, so re-applying cannot duplicate an entry or drop one that a later
-- migration added in between. `terminal` is true: a cancelled request is finished, and nothing
-- transitions out of it.
update public.workflow_registry_modules
set statuses = statuses || jsonb_build_array(
      jsonb_build_object('key', 'cancelled', 'label', 'Cancelled', 'terminal', true)
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(statuses) s where s->>'key' = 'cancelled'
  );

-- Every field the loader requires is present. `auditLog` and `label` go through
-- normalizeRequiredText and each role through parseRoleStrict — a missing auditLog or a role string
-- that is not a real role throws in the loader, which means the module is skipped and direct orders
-- stop working entirely. The allowed roles mirror `submit_held` exactly: whoever can put an order
-- into the held lane can take their own back out of it.
update public.workflow_registry_modules
set actions = actions || jsonb_build_array(
      jsonb_build_object(
        'key', 'cancel_held',
        'label', 'Requester withdrew a held request (duplicate, or raised in error)',
        'from', jsonb_build_array('held'),
        'to', 'cancelled',
        'auditLog', 'Direct order cancelled by its requester while held',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('close request'),
        'notifications', jsonb_build_array('notify requester + CC'),
        'tests', jsonb_build_array('only the requester or a Super Admin may cancel, and only while held'),
        'allowedRoles', jsonb_build_array(
          'District Manager',
          'Regional Manager',
          'National Sales Manager',
          'Product Manager',
          'Group Product Manager',
          'Super Admin'
        )
      )
    ),
    version = version + 1,
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(actions) a where a->>'key' = 'cancel_held'
  );

-- Note for whoever reads the version number next: `workflow_registry_modules_touch`, a BEFORE
-- UPDATE trigger, already bumps `version` on every write, so the explicit bump above is redundant
-- and the row moved 5 -> 7 rather than 5 -> 6 when this was applied to production on 2026-08-05.
-- Left as written because that is exactly what production received, and `version` is display
-- metadata — nothing reads it to make a decision. The counts are the real check: 9 statuses and
-- 12 actions, verified live.

-- Simulate the loader before committing. This is the check whose absence cost an outage: if any
-- action references a status the module does not declare, the whole module is skipped at runtime
-- and the failure surfaces only as a log line. Failing here instead rolls the transaction back.
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
