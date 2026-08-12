-- Direct orders: the HELD lane (spec B6 — docs/specs/direct-orders-v2.md).
--
-- Owner design, 2026-08-04: an order whose pharmacy is not in the master database may still be
-- SUBMITTED, but it stands outside the building — status 'held': no approval chain, no approver
-- queues, no sales path (sales are already Finance-month gated), a 14-day clock, and revival
-- into the chain only after the pharmacy passes validation. An untouched held order expires by
-- itself as 'expired' — logged, counted, named.
--
-- Sequencing note (Railway applies no migrations): this must be applied to staging + production
-- BEFORE the code that submits 'held' orders merges, or the registry gate refuses every
-- unknown-pharmacy submission at the last write. Additive — old code never emits these actions.

-- 1) The status vocabulary gains 'held' and 'expired'.
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
    'expired'::text
  ]));

-- 2) The clock. Set on entering 'held'; the sweep expires anything older than 14 days.
alter table public.direct_order_requests
  add column if not exists held_at timestamptz;

-- 3) The workflow registry learns the two new STATUSES and the three transitions. ONE update, so
--    ONE version bump; `version` is trigger-owned and deliberately not mentioned. The @> guard makes
--    a re-run a no-op instead of a duplicate action set.
update public.workflow_registry_modules
set
  -- THE STATUSES THE ACTIONS BELOW REFERENCE. Added 2026-08-12, correcting this file eight days
  -- late: the CHECK constraint in step 1 was updated and the actions here were appended, but
  -- `workflow_registry_modules.statuses` never was. From 2026-08-04 the module therefore declared
  -- actions pointing at statuses it did not declare. normalizeActions() throws on that,
  -- listWorkflowRegistryModules() catches, logs and SKIPS THE WHOLE MODULE, and every
  -- direct_orders transition then refuses — reps cannot raise an order at all. That is the
  -- 2026-08-05 outage, one day later, and why every direct-orders migration since carries a
  -- loader simulation.
  --
  -- IN THE SAME UPDATE AS THE ACTIONS, not a statement of its own. `workflow_registry_modules_touch`
  -- is a BEFORE UPDATE trigger that bumps `version` once per UPDATE, so three statements would be
  -- three bumps — the exact drift that moved the row 5 -> 7 instead of 5 -> 6 on 2026-08-05. One
  -- statement also means the vocabulary and the actions that depend on it land atomically.
  --
  -- WHY EDIT AN APPLIED FILE AT ALL. This fixes REPLAY: migrations run in timestamp order, so a
  -- database built from scratch reached 20260805150000_direct_orders_cancel_held.sql — the first
  -- file carrying a loader simulation — and that simulation correctly refused to commit. The chain
  -- could not be replayed at all. Only a fix HERE, before these actions are appended, repairs that.
  -- It changes nothing on a database that has already applied this file: Supabase records history
  -- by VERSION, the version is unchanged, and so this never runs there again. Those environments
  -- are repaired by 20260812135000_direct_orders_declare_held_expired_statuses.sql instead.
  --
  -- The per-status `case` keeps it idempotent even if a future state has one but not the other.
  statuses = statuses
    || (case
          when exists (select 1 from jsonb_array_elements(statuses) s where s->>'key' = 'held')
          then '[]'::jsonb
          else jsonb_build_array(jsonb_build_object(
            'key', 'held',
            'label', 'Customer Verification Required',
            'description', 'Submitted, but the pharmacy is not in the master database, so the order is in no approver''s queue. It moves when the pharmacy is verified, or expires after 14 days.'
          ))
        end)
    || (case
          when exists (select 1 from jsonb_array_elements(statuses) s where s->>'key' = 'expired')
          then '[]'::jsonb
          else jsonb_build_array(jsonb_build_object(
            'key', 'expired',
            'label', 'Expired',
            'description', 'The pharmacy was never verified, so the order timed out after 14 days without ever reaching an approver.'
          ))
        end),
  actions = actions || '[
  {
    "key": "submit_held",
    "from": ["draft", "returned"],
    "to": "held",
    "label": "Requester submits a direct order whose pharmacy awaits validation",
    "allowedRoles": ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Super Admin"],
    "requiresReason": false,
    "auditLog": "Direct order submitted as held (pharmacy not in master database)",
    "sideEffects": ["no approval chain is seeded until the pharmacy is validated"],
    "notifications": ["notify requester"],
    "tests": ["unknown-pharmacy submit lands held, seeds no steps"]
  },
  {
    "key": "revive_held",
    "from": ["held"],
    "to": "pending_approval",
    "label": "Pharmacy validated — the request enters the approval chain from step 1",
    "allowedRoles": ["Super Admin", "SFE Manager"],
    "requiresReason": false,
    "auditLog": "Direct order revived after pharmacy validation",
    "sideEffects": ["seed approval chain"],
    "notifications": ["notify requester + first approver"],
    "tests": ["validation revives every held order of the pharmacy"]
  },
  {
    "key": "expire_held",
    "from": ["held"],
    "to": "expired",
    "label": "Held request expired unclaimed after 14 days",
    "allowedRoles": ["Super Admin"],
    "requiresReason": false,
    "auditLog": "Direct order expired (held 14 days without a valid pharmacy)",
    "sideEffects": ["close request"],
    "notifications": ["notify requester + CC"],
    "tests": ["the sweep expires only past-deadline held orders"]
  }
]'::jsonb
where module_key = 'direct_orders'
  and not (actions @> '[{"key": "submit_held"}]'::jsonb);
