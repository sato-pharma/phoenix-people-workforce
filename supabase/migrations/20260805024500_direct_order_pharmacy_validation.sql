-- Direct orders Stage 2: Pharmacy Validation + probation (spec A2/A3 — docs/specs/direct-orders-v2.md).
--
-- The owner's design, in one line: a pharmacy the distributor sheets do not know may still be
-- admitted, but only through a door with evidence on it, and it stays on probation until the data
-- confirms it is real.
--
-- Why evidence and not trust: the reps who create phantom pharmacies benefit from the sale being
-- untrackable, so the claim itself carries no information. A live storefront photo whose GPS pin
-- falls inside the requester's own area is a different category of assertion — deniable typing
-- becomes undeniable evidence, which is what makes the honest path the cheap one.
--
-- Deliberately mirrors the marketing Customer Validation flow (same evidence columns, same private
-- bucket idea, same signed-URL reads), because staff already use that flow every week. Reusing a
-- familiar shape is what stops "the new system blocked everything".

-- ── 1. The validation request ────────────────────────────────────────────────
create table if not exists public.direct_order_pharmacy_validations (
  id uuid primary key default gen_random_uuid(),
  -- The pharmacy under review. It already exists (created pending_review by the held order), so
  -- validation never invents an identity — it either confirms this one or points it at a real
  -- directory customer instead.
  pharmacy_id uuid not null references public.direct_order_pharmacies(id) on delete cascade,
  -- The held order that triggered this. Nullable: a registry-initiated validation has no order.
  request_id uuid references public.direct_order_requests(id) on delete set null,
  requested_by_hr_id text not null,
  requested_at timestamptz not null default now(),

  -- What the requester claims.
  claimed_pharmacy_name text not null,
  claimed_address text,
  claimed_doctor_name text,
  -- Why this pharmacy is not in the master database, in the requester's own words.
  claimed_reason text,

  -- Where the requester was standing. `area_code` is their OWN area at capture time; the pin must
  -- fall inside it, and both are stored so a later dispute reads the same numbers the decision did.
  captured_latitude double precision,
  captured_longitude double precision,
  captured_accuracy_meters double precision,
  captured_at timestamptz,
  captured_address text,
  requester_area_code text,
  -- Resolved server-side at submission, never sent by the browser.
  gps_inside_requester_area boolean,

  -- Evidence photo (private bucket; read only through a short-lived signed URL).
  storage_bucket text not null default 'direct-order-evidence',
  storage_path text,

  status text not null default 'pending'
    check (status in ('pending', 'approved_new', 'matched_existing', 'rejected')),
  decided_by_hr_id text,
  decided_at timestamptz,
  decision_notes text,

  -- Set when the Super Admin resolves the claim to a customer that already existed. This is the
  -- OUTCOME WE WANT most of the time: the pharmacy was real but spelled differently.
  matched_distributor_code text,
  matched_customer_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One OPEN validation per pharmacy: a second request while one is pending would give the admin two
-- desks for one identity and let a rejected claim be re-opened by simply asking again.
create unique index if not exists direct_order_pharmacy_validations_one_open
  on public.direct_order_pharmacy_validations (pharmacy_id)
  where status = 'pending';

create index if not exists direct_order_pharmacy_validations_status_idx
  on public.direct_order_pharmacy_validations (status, requested_at desc);

comment on table public.direct_order_pharmacy_validations is
  'Pharmacy Validation requests (spec A2). Mirrors marketing Customer Validation: live GPS-stamped '
  'storefront photo + claimed details, decided by a Super Admin who may match it to an existing '
  'directory customer, approve it as new (provisional), or reject it.';

-- ── 2. Probation on the pharmacy itself ─────────────────────────────────────
-- A Super Admin approval admits an identity; it does not make it true. A real pharmacy that
-- received real stock leaves a footprint — it appears in a distributor sheet, or its collection is
-- paid. Probation is the clock on that promise, and it is what makes a wrong approval self-correct
-- instead of becoming permanent truth.
alter table public.direct_order_pharmacies
  add column if not exists trust_state text not null default 'trusted'
    check (trust_state in ('trusted', 'provisional', 'phantom_suspected')),
  add column if not exists probation_started_at timestamptz,
  add column if not exists trusted_at timestamptz,
  add column if not exists trusted_reason text,
  add column if not exists phantom_reported_at timestamptz;

comment on column public.direct_order_pharmacies.trust_state is
  'trusted = came from the distributor sheets, or a footprint confirmed it. provisional = admitted '
  'by Super Admin validation, still owes a footprint. phantom_suspected = probation expired with no '
  'distributor sales and no payment (spec A3).';

create index if not exists direct_order_pharmacies_probation_idx
  on public.direct_order_pharmacies (trust_state, probation_started_at)
  where trust_state = 'provisional';

-- ── 3. The evidence bucket ──────────────────────────────────────────────────
-- PRIVATE, 2 MB, JPEG only — byte-for-byte the `marketing-evidence` policy, because this holds the
-- same kind of object: a GPS-stamped photograph of a real shop front. Private matters: these are
-- reachable only through short-lived signed URLs minted server-side, never a shareable link.
-- The MIME allow-list is a second wall behind the JPEG-only parser, so a gallery upload cannot
-- reach storage even if a caller bypassed the service.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('direct-order-evidence', 'direct-order-evidence', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

-- ── 4. Workflow registry: the validation transitions ────────────────────────
-- Guarded so a re-run is a no-op; `version` is trigger-owned and deliberately not mentioned.
update public.workflow_registry_modules
set actions = actions || '[
  {
    "key": "request_pharmacy_validation",
    "from": ["held"],
    "to": "held",
    "label": "Requester submits pharmacy validation evidence for a held order",
    "allowedRoles": ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Super Admin"],
    "requiresReason": true,
    "auditLog": "Pharmacy validation requested with location and photograph",
    "sideEffects": ["order stays held until the validation is decided"],
    "notifications": ["notify Super Admin desk"],
    "tests": ["validation request requires a GPS-stamped live photo inside the requester area"]
  },
  {
    "key": "decide_pharmacy_validation",
    "from": ["held"],
    "to": "held",
    "label": "Super Admin decides a pharmacy validation (match, approve as new, or reject)",
    "allowedRoles": ["Super Admin"],
    "requiresReason": false,
    "auditLog": "Pharmacy validation decided",
    "sideEffects": ["approval confirms the pharmacy and revives its held orders", "match rewires the pharmacy to a directory customer"],
    "notifications": ["notify requester"],
    "tests": ["approval revives held orders; rejection leaves them held"]
  }
]'::jsonb
where module_key = 'direct_orders'
  and not (actions @> '[{"key": "request_pharmacy_validation"}]'::jsonb);
