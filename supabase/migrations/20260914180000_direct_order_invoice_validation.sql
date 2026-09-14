-- A distributor invoice as validation evidence for a new direct-order pharmacy.
--
-- WHY. Owner's instruction, 2026-09-14: "store the invoice as validation evidence and when the
-- validation goes to SFE must show the invoice uploaded and every one maximum can validate 5
-- pharmacies with invoices". An invoice a distributor issued to the pharmacy is the distributor
-- vouching for the shop, so it is accepted ON ITS OWN — no pin, no storefront photo, no licence —
-- but only for up to FIVE open pharmacies per rep. The rep frees a slot by later validating one of
-- those pharmacies in the field with a live photo and location; a rejected invoice claim gives its
-- slot back. The limit is enforced in `src/lib/direct-orders/pharmacy-validation.ts`, because an
-- open slot depends on later field validations and on the pharmacy's own status — not a shape a
-- CHECK constraint can express.
--
-- Decided by BOTH the Super Admin and the SFE Manager (owner's answer). The SFE Manager decides
-- invoice claims only; a live-photo claim stays with the Super Admin, exactly as before.

begin;

-- ── 0. The invoice bucket ───────────────────────────────────────────────────────────────────────
-- ITS OWN PRIVATE BUCKET, for the same reason the licence got one: `direct-order-evidence` is
-- JPEG-only with a 2MB ceiling and that allow-list is a second wall behind the live-capture parser.
-- An invoice is a document — a photo, a scan or a PDF — and must not widen that wall.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'direct-order-invoices',
      'direct-order-invoices',
      false,
      5242880,
      array['image/jpeg', 'image/png', 'application/pdf']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists direct_order_invoices_service_role on storage.objects';
    execute $policy$
      create policy direct_order_invoices_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'direct-order-invoices')
      with check (bucket_id = 'direct-order-invoices')
    $policy$;
  end if;
end $$;

-- ── 1. The route and the invoice on the validation row ─────────────────────────────────────────
-- Every existing row was filed with a live photo and a pin, so the default `field` is the truth
-- about all of them — no backfill is needed.
alter table public.direct_order_pharmacy_validations
  add column if not exists validation_route text not null default 'field',
  add column if not exists invoice_storage_path text,
  add column if not exists invoice_content_type text,
  add column if not exists invoice_uploaded_at timestamptz;

comment on column public.direct_order_pharmacy_validations.validation_route is
  'field = live photo and location; invoice = a distributor invoice alone (limited to 5 open pharmacies per rep).';
comment on column public.direct_order_pharmacy_validations.invoice_storage_path is
  'Distributor invoice, in the private direct-order-invoices bucket. Only on an invoice-route claim.';
comment on column public.direct_order_pharmacy_validations.invoice_content_type is
  'image/jpeg, image/png or application/pdf — what the reviewer''s browser is asked to open.';

alter table public.direct_order_pharmacy_validations
  drop constraint if exists direct_order_pharmacy_validations_route_check;
alter table public.direct_order_pharmacy_validations
  add constraint direct_order_pharmacy_validations_route_check
  check (validation_route = any (array['field'::text, 'invoice'::text]));

alter table public.direct_order_pharmacy_validations
  drop constraint if exists direct_order_pharmacy_validations_invoice_content_type_check;
alter table public.direct_order_pharmacy_validations
  add constraint direct_order_pharmacy_validations_invoice_content_type_check
  check (
    invoice_content_type is null
    or invoice_content_type = any (array['image/jpeg'::text, 'image/png'::text, 'application/pdf'::text])
  );

-- An invoice belongs to an invoice claim and nothing else, so a field claim can never be read as
-- "validated by invoice" because a stray path landed on it.
alter table public.direct_order_pharmacy_validations
  drop constraint if exists direct_order_pharmacy_validations_invoice_route_check;
alter table public.direct_order_pharmacy_validations
  add constraint direct_order_pharmacy_validations_invoice_route_check
  check (invoice_storage_path is null or validation_route = 'invoice');

-- The slot counter reads one rep's invoice claims by status on every capture screen.
create index if not exists direct_order_pharmacy_validations_invoice_slots_idx
  on public.direct_order_pharmacy_validations (requested_by_hr_id, status)
  where validation_route = 'invoice';

-- ── 2. The SFE Manager may decide (invoice claims — narrowed in the service) ───────────────────
-- ONE registry update, so one version bump; `version` is trigger-owned and never set here.
update public.workflow_registry_modules as m
set actions = (
      select jsonb_agg(
               case
                 when elements.action->>'key' in ('decide_pharmacy_validation')
                  and not (elements.action->'allowedRoles' @> '["SFE Manager"]'::jsonb)
                 then jsonb_set(elements.action, '{allowedRoles}', (elements.action->'allowedRoles') || '["SFE Manager"]'::jsonb)
                 else elements.action
               end
               order by elements.ordinality
             )
        from jsonb_array_elements(m.actions) with ordinality as elements(action, ordinality)
    ),
    updated_by = 'system'
where m.module_key = 'direct_orders'
  and exists (
    select 1
      from jsonb_array_elements(m.actions) as probe(action)
     where probe.action->>'key' = 'decide_pharmacy_validation'
       and not (probe.action->'allowedRoles' @> '["SFE Manager"]'::jsonb)
  );

-- Proves the grant landed rather than trusting the row count: a registry the app reads without
-- the SFE Manager would refuse every invoice decision they make with a sentence nobody can act on.
do $$
begin
  if exists (select 1 from public.workflow_registry_modules where module_key = 'direct_orders')
     and not exists (
       select 1
         from public.workflow_registry_modules as m,
              jsonb_array_elements(m.actions) as a(action)
        where m.module_key = 'direct_orders'
          and a.action->>'key' = 'decide_pharmacy_validation'
          and a.action->'allowedRoles' @> '["SFE Manager"]'::jsonb
     ) then
    raise exception 'decide_pharmacy_validation does not list SFE Manager after the patch';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
