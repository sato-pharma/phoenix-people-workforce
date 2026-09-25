-- ─────────────────────────────────────────────────────────────────────────────
-- The ManageEngine enrollment template a factory-fresh rep tablet scans.
--
-- WHAT
--   public.manageengine_enrollment_template — exactly one row (id = 1), holding
--   the Android provisioning JSON that ManageEngine's console generates for an
--   enrollment template, plus the template's name and who last saved it.
--
-- WHY
--   ManageEngine's REST API has Devices, Profiles, Apps and Actions — and NO
--   enrollment endpoint at all. The QR that provisions a tablet as fully managed
--   is generated in the ManageEngine console (Enrollment → Android → QR Code) and
--   is not mintable over the API, so Phoenix cannot make one on demand the way it
--   does for Google's Android Management API. The owner therefore copies that
--   template's payload into Phoenix once, and the Rep Tablets page renders it as a
--   scannable QR for every tablet from then on — no console trip per tablet.
--
--   This replaces Google's enrollment path as the one that actually works: a new
--   Google Cloud project carries a device quota of ZERO until Google approves an
--   application, which is why the Google QR is refused on the tablet with "your
--   organization has reached its usage limits" while the enterprise holds no
--   devices at all.
--
-- 🔴 THE PAYLOAD IS A CREDENTIAL. Anyone who scans it puts a tablet into the
--   company's fleet. RLS is on with no permissive policy and anon/authenticated
--   are revoked, so it is reachable only through the service-role client behind
--   `company_devices:approve`. It is never logged and never returned by the page's
--   ordinary read — the page asks for it explicitly, the same way the Google
--   enrollment code is revealed and hidden today.
--
--   Unlike Google's token it carries NO per-tablet data: ManageEngine's admin
--   extras bundle is ManageEngine's own and Phoenix does not touch it. A tablet is
--   matched to its custody-register entry after enrollment, by serial and IMEI.
--
-- ROLLBACK
--   drop table if exists public.manageengine_enrollment_template;
--   (Purely additive — no existing table is touched, no data coerced.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole
-- recovery story. This change creates one empty table; it is neither destructive
-- nor bulk.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.manageengine_enrollment_template (
  id            smallint    primary key default 1 check (id = 1),
  template_name text,
  qr_payload    text        not null,
  updated_by    text        not null,
  updated_at    timestamptz not null default now()
);

comment on table public.manageengine_enrollment_template is
  'The Android provisioning JSON from a ManageEngine enrollment template, copied once from the '
  'ManageEngine console because their REST API exposes no enrollment endpoint. One row (id = 1). '
  'CREDENTIAL: scanning it enrolls a tablet into the company fleet — service-role only, never logged.';

comment on column public.manageengine_enrollment_template.qr_payload is
  'The provisioning JSON exactly as ManageEngine generated it, re-serialised after validation. '
  'Phoenix renders it as a QR and never alters the admin extras bundle inside it.';

comment on column public.manageengine_enrollment_template.updated_by is
  'Who last saved it — the acting HR id, employee identity or login, as the audit row records.';

-- Application-scoped, read through the service-role client only. RLS on with no
-- permissive policy so the public anon key cannot reach it; service_role bypasses RLS.
alter table public.manageengine_enrollment_template enable row level security;
revoke all on public.manageengine_enrollment_template from anon, authenticated;
grant select, insert, update on public.manageengine_enrollment_template to service_role;

commit;
