-- ─────────────────────────────────────────────────────────────────────────────
-- The Headwind enrollment code a factory-fresh rep tablet scans.
--
-- WHAT
--   public.headwind_enrollment_template — exactly one row (id = 1), holding the
--   Android provisioning JSON the company's OWN Headwind server generates, plus a
--   name for it and who last saved it. The same shape, and the same reasoning, as
--   public.manageengine_enrollment_template beside it.
--
-- WHY A STORED COPY AND NOT A MINTED ONE
--   Phoenix cannot generate this code. The provisioning payload pins the agent APK
--   by its SIGNATURE CHECKSUM, and the APK is the one the Headwind box itself
--   serves — so a payload Phoenix invented would either carry no checksum (which a
--   factory-fresh tablet refuses) or a checksum for a file it has never seen. The
--   owner copies the code out of the Headwind console once, and Phoenix redraws it
--   for every tablet from then on, with no console trip per tablet.
--
--   The Headwind-specific keys inside the bundle — com.hmdm.BASE_URL,
--   SERVER_PROJECT, DEVICE_ID, CONFIG, GROUP, SKIP_INTRO, OPEN_WIFI — are the
--   agent's own and are passed through byte-for-byte. A tablet is matched to its
--   custody-register entry after enrolment, by serial and IMEI, exactly as the
--   ManageEngine path already does.
--
-- 🔴 THE PAYLOAD IS A CREDENTIAL. Anyone who scans it puts a tablet into the
--   company's fleet, with the agent as device owner. RLS is on with NO permissive
--   policy and anon/authenticated are revoked, so it is reachable only through the
--   service-role client behind `company_devices:approve`. It is never logged, never
--   returned by the page's ordinary read, and never written into an audit row —
--   an audit trail that stores the credential it audits hands it to every reader.
--
-- WHY A SECOND TABLE RATHER THAN A ROW IN THE FIRST
--   The two systems run side by side during the changeover, and each has exactly
--   one enrolment code. Sharing one table would mean a second row and a discriminator
--   on a table whose entire safety argument is "there is one row, id = 1".
--
-- ROLLBACK
--   drop table if exists public.headwind_enrollment_template;
--   (Purely additive — no existing table is touched, no data coerced, no grant on
--   any other object changed.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery
-- story. This change creates one EMPTY table. It is neither destructive nor bulk:
-- nothing is dropped, altered, backfilled or deleted.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.headwind_enrollment_template (
  id            smallint    primary key default 1 check (id = 1),
  template_name text,
  qr_payload    text        not null,
  updated_by    text        not null,
  updated_at    timestamptz not null default now()
);

comment on table public.headwind_enrollment_template is
  'The Android provisioning JSON from the company''s own Headwind MDM server, copied once from its '
  'console because the code pins the agent APK by signature checksum and cannot be minted elsewhere. '
  'One row (id = 1). CREDENTIAL: scanning it enrolls a tablet into the company fleet with the agent '
  'as device owner — service-role only, never logged, never audited.';

comment on column public.headwind_enrollment_template.qr_payload is
  'The provisioning JSON exactly as Headwind generated it, re-serialised after validation. Phoenix '
  'renders it as a QR and never alters the com.hmdm.* admin extras bundle inside it.';

comment on column public.headwind_enrollment_template.updated_by is
  'Who last saved it — the acting HR id, employee identity or login, as the audit row records.';

-- Application-scoped, read through the service-role client only. RLS on with no
-- permissive policy so the public anon key cannot reach it; service_role bypasses RLS.
alter table public.headwind_enrollment_template enable row level security;
revoke all on public.headwind_enrollment_template from anon, authenticated;
grant select, insert, update on public.headwind_enrollment_template to service_role;

commit;
