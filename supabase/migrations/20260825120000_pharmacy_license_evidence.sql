-- Pharmacy trade licence (رخصة الصيدلية) as identity evidence, in BOTH validation desks.
--
-- WHY. Direct Orders and Marketing Requests each ask a Super Admin to mint a brand-new venue
-- identity. In the normal case the identity is already vouched for by somebody outside Phoenix: a
-- distributor code means a real company invoiced a real pharmacy under that name. A venue with NO
-- code in ANY distributor has none of that, and the storefront photo Phoenix already holds proves
-- only WHERE the shop is, never WHO it is. Owner's instruction 2026-08-25: let the licence be
-- attached alongside the validation, so the trade name on the licence can be compared against the
-- name on the shop sign (اليافطة) in the photo the same submission already carries.
--
-- ALWAYS OPTIONAL — nothing here is NOT NULL and nothing gates a decision. The system flags, it
-- never rejects (owner's standing rule).
--
-- BOTH MODULES KEEP THEIR OWN STORAGE SHAPE, deliberately. Direct Orders indexes its evidence on
-- the validation row itself (storage_bucket / storage_path columns); Marketing indexes its evidence
-- in marketing_evidence_files, one row per file. Forcing one shape on both would mean rewriting a
-- working read path in the other module for no gain to this feature.

begin;

-- ── 0. The licence bucket ───────────────────────────────────────────────────────────────────────
-- ITS OWN BUCKET, and neither existing evidence bucket is touched. `direct-order-evidence` and
-- `marketing-evidence` are both provisioned `array['image/jpeg']` with a 2MB ceiling, and that MIME
-- allow-list is a SECOND WALL behind the live-capture parser — a gallery upload cannot reach storage
-- even if a caller got past the service. Widening either to admit a PDF would take that wall down
-- for the storefront photos as well, which is a real guard traded away for a feature that does not
-- need it. (tests/direct-orders-pharmacy-validation.test.ts pins that allow-list; it still passes.)
--
-- Private, like both of them: a licence carries a real business's registration details and is
-- reachable only through a short-lived signed URL minted server-side. Same shape as
-- 20260804140000_marketing_evidence_photo_bucket.sql, which is the pattern that works here.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'pharmacy-licenses',
      'pharmacy-licenses',
      false,
      -- 5MB. The 2MB cap sizes a quality-0.86 canvas JPEG the app itself produced; this holds
      -- whatever a pharmacist's scanner produced, and a multi-page trade licence clears 2MB with
      -- nothing wrong with it.
      5242880,
      array['image/jpeg', 'image/png', 'application/pdf']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists pharmacy_licenses_service_role on storage.objects';
    execute $policy$
      create policy pharmacy_licenses_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'pharmacy-licenses')
      with check (bucket_id = 'pharmacy-licenses')
    $policy$;
  end if;
end $$;

-- ── 1. Direct Orders ────────────────────────────────────────────────────────────────────────────
-- The path is keyed on the validation id, exactly like storage_path. There is no
-- `license_storage_bucket` column beside it on purpose: the licence bucket is one fixed name shared
-- by both modules (`PHARMACY_LICENSE_BUCKET`), so a per-row copy of it would be a second place for
-- the same fact to be wrong. `storage_bucket` above still describes `storage_path` and only that.

alter table public.direct_order_pharmacy_validations
  add column if not exists license_storage_path text,
  add column if not exists license_content_type text,
  add column if not exists license_uploaded_at timestamptz,
  -- The APPROVER'S verdict on the comparison the licence exists to make, recorded at decision time.
  -- Three-valued on purpose: NULL means nobody was asked (no licence on file, or a claim decided
  -- before this shipped) and must never be rendered as "checked and fine" — the same rule
  -- evidence_check already follows on this table.
  add column if not exists license_name_matches_sign boolean;

comment on column public.direct_order_pharmacy_validations.license_storage_path is
  'Pharmacy trade licence, in the private pharmacy-licenses bucket. NULL = none attached.';
comment on column public.direct_order_pharmacy_validations.license_content_type is
  'image/jpeg, image/png or application/pdf — what the approver''s browser is asked to open.';
comment on column public.direct_order_pharmacy_validations.license_name_matches_sign is
  'Approver''s verdict that the licence trade name matches the shop sign. NULL = never asked.';

-- Refuses a content type no approver could open, and refuses a verdict about a licence that is not
-- there — the shape that would let "checked" be recorded against nothing.
alter table public.direct_order_pharmacy_validations
  drop constraint if exists direct_order_pharmacy_validations_license_content_type_check;
alter table public.direct_order_pharmacy_validations
  add constraint direct_order_pharmacy_validations_license_content_type_check
  check (
    license_content_type is null
    or license_content_type = any (array['image/jpeg'::text, 'image/png'::text, 'application/pdf'::text])
  );

alter table public.direct_order_pharmacy_validations
  drop constraint if exists direct_order_pharmacy_validations_license_verdict_check;
alter table public.direct_order_pharmacy_validations
  add constraint direct_order_pharmacy_validations_license_verdict_check
  check (license_name_matches_sign is null or license_storage_path is not null);

-- ── 2. Marketing Requests ───────────────────────────────────────────────────────────────────────
-- marketing_evidence_files already carries one row per stored file with an evidence_type
-- discriminator; the licence is a fourth kind. Extending the CHECK is the whole change — the index
-- table, its RLS posture and the signed-URL read path are reused as they stand. `storage_bucket` is
-- a per-row column, so a licence row simply names `pharmacy-licenses` while every photo row goes on
-- naming `marketing-evidence`; the column's DEFAULT is untouched.
--
-- 'other' was NOT reused. Every existing reader filters on evidence_type = 'location_photo', so a
-- licence stored as 'other' would be invisible to them by luck rather than by rule, and the next
-- reader that forgets the filter would render a licence where a shop front belongs.

alter table public.marketing_evidence_files
  drop constraint if exists marketing_evidence_files_evidence_type_check;
alter table public.marketing_evidence_files
  add constraint marketing_evidence_files_evidence_type_check
  check (
    evidence_type = any (
      array['location_photo'::text, 'sign_photo'::text, 'pharmacy_license'::text, 'other'::text]
    )
  );

-- content_type has never been constrained on this table and is not constrained now: the licence is
-- the first non-JPEG it will hold, and adding a whitelist here would retro-refuse nothing while
-- risking a false positive against rows written before anyone thought about it.

-- The licence read path filters on (entity_type, evidence_type, entity_id). The existing index
-- keyed on (entity_type, entity_id) already serves it, but a partial index keeps the licence lookup
-- off the far larger location_photo population as that table grows.
create index if not exists marketing_evidence_files_license_idx
  on public.marketing_evidence_files (entity_id, created_at desc)
  where evidence_type = 'pharmacy_license';

commit;
