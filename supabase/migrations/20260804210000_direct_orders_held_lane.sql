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

-- 3) The workflow registry learns the three transitions. ONE update, appended to the existing
--    actions array; `version` is trigger-owned and deliberately not mentioned. The @> guard makes
--    a re-run a no-op instead of a duplicate action set.
update public.workflow_registry_modules
set actions = actions || '[
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
