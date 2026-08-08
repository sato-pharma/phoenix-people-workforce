-- Direct Orders — release_held / keep_held (owner rule, 2026-08-08)
--
-- THE INSIGHT: the Sato pharmacy code (DOP-000123) is only Phoenix's own internal reference. The
-- DISTRIBUTOR customer code is the real evidence — a code the distributor's master database
-- recognises, in the brick the request declares, proves the pharmacy exists.
--
-- Until now the held fork read `verification_status` and NOTHING else, so a hand-typed pharmacy
-- whose code resolved perfectly and one with no code at all were frozen identically outside the
-- approval chain. Eight live orders worth 243,871.75 EGP were sitting in that lane the day this was
-- written, one of them provable from its own code.
--
-- Two new actions:
--   release_held  — the code proves the pharmacy, OR a System Admin judged it. The order joins the
--                   chain at rung 1, which is the SFE Manager, so review is NOT skipped. Nothing
--                   here writes `verification_status`; only a human rung may confirm a pharmacy, and
--                   the final-approval backstop still refuses while it is `pending_review`.
--   keep_held     — a System Admin looked at an unprovable code and ruled the request stays held.
--                   Status does not change; the point is the recorded decision and its reason.
--
-- `revive_held` is deliberately NOT reused: its auditLog says the pharmacy passed validation. It did
-- not. Different authority, different audit line, different word — the same reasoning that made
-- `cancel_held` its own action rather than a reuse of `rejected`.
--
-- NO NEW STATUSES, ON PURPOSE. Both targets ('pending_approval', 'held') are already declared. The
-- 2026-08-05 outage — every direct_orders transition dead, reps unable to raise an order at all —
-- happened because an action referenced an UNDECLARED status: normalizeActions() throws,
-- listWorkflowRegistryModules() catches, logs, and SKIPS the whole module. This file therefore
-- cannot reproduce that failure, and a later edit must not add a status here. The loader simulation
-- at the end still runs, because the guarantee should be enforced rather than trusted.

begin;

-- 1. The System Admin's persisted ruling. Additive, nullable, no default change — every existing
--    row keeps meaning "nobody has ruled", which is distinct from either answer.
--
--    Pharmacy-level rather than request-level, mirroring reviveHeldDirectOrdersForPharmacy: "I know
--    this pharmacy is real" is a statement about the pharmacy, so it must cover sibling orders and
--    the next one submitted. Request-level would re-freeze every reorder.
alter table public.direct_order_pharmacies
  add column if not exists hold_release_ground text,
  add column if not exists hold_release_reason text,
  add column if not exists hold_release_decided_by_hr_id text,
  add column if not exists hold_release_decided_at timestamptz;

alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_hold_release_ground_check;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_hold_release_ground_check
  check (
    hold_release_ground is null
    or hold_release_ground = any (array['admin_released'::text, 'kept_held'::text])
  );

comment on column public.direct_order_pharmacies.hold_release_ground is
  'A System Admin''s explicit ruling on a pharmacy whose distributor code proves nothing. '
  'admin_released = its held orders join the approval chain; kept_held = somebody looked and they stay. '
  'NULL means nobody has ruled, which is NOT the same as either answer and must never be collapsed into one.';

-- 2. EXACTLY ONE update to the registry row. Two separate updates would be two version bumps and
--    two trigger fires for what is one logical change.
--
--    Every field the loader requires is present: `label` and `auditLog` go through
--    normalizeRequiredText and each role through parseRoleStrict — a missing auditLog or a role
--    string that is not a real role throws in the loader, and a thrown loader means the module is
--    skipped and direct orders stop working entirely.
--
--    release_held mirrors revive_held's roles (Super Admin + SFE Manager): the same people who can
--    bring a pharmacy's held orders back may release a proven one. keep_held is Super Admin only,
--    matching expire_held and decide_pharmacy_validation — it is a System Admin's judgement call.
update public.workflow_registry_modules
set actions = actions || jsonb_build_array(
      jsonb_build_object(
        'key', 'release_held',
        'label', 'Released into the approval chain — the distributor code proves the pharmacy, or a System Admin judged it',
        'from', jsonb_build_array('held'),
        'to', 'pending_approval',
        'auditLog', 'Direct order released from the held lane into the approval chain at step 1',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('seed approval chain', 'clear held_at'),
        'notifications', jsonb_build_array('notify requester + first approver'),
        'tests', jsonb_build_array('a released order enters at the SFE rung and its pharmacy stays pending_review'),
        'allowedRoles', jsonb_build_array('Super Admin', 'SFE Manager')
      ),
      jsonb_build_object(
        'key', 'keep_held',
        'label', 'System Admin looked at an unprovable code and decided the request stays held',
        'from', jsonb_build_array('held'),
        'to', 'held',
        'auditLog', 'Direct order deliberately kept held by a System Admin, with a recorded reason',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('record the hold decision on the pharmacy'),
        'notifications', jsonb_build_array('notify requester'),
        'tests', jsonb_build_array('keeping a request held records a reason and changes no status'),
        'allowedRoles', jsonb_build_array('Super Admin')
      )
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(actions) a where a->>'key' in ('release_held', 'keep_held')
  );

-- `version` is deliberately NOT set here. workflow_registry_modules_touch is a BEFORE UPDATE trigger
-- that already bumps it; setting it explicitly is what moved the row 5 -> 7 instead of 5 -> 6 on
-- 2026-08-05. The counts are the real check: 9 statuses (unchanged) and 14 actions after this.

-- 3. Simulate the loader before committing — the check whose absence cost the outage. If any action
--    references a status the module does not declare, the whole module is skipped at runtime and the
--    failure surfaces only as a log line. Failing here rolls the transaction back instead.
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
