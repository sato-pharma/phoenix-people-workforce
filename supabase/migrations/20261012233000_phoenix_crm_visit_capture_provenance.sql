-- phoenix_crm_visit_capture_provenance
--
-- WHAT THIS CHANGES: one new table and nothing else. No column is added to
-- `phoenix_crm_visits`, no function is replaced, no existing row is touched, and nothing a rep can
-- see changes in any way. `phoenix_crm_save_visit` is deliberately NOT re-emitted: it is a 300-line
-- function that three migrations already replace in turn, and re-stating it to carry four more
-- fields would put the whole visit save at risk for facts that nothing on the save path reads.
-- The server writes this row immediately after the save, exactly where `judgeCapture` already runs.
--
-- WHY IT EXISTS. Two things the phone knows about every one-tap visit were being thrown away.
--
--   1. WHEN THE POSITION WAS ACTUALLY TAKEN. `use-silent-fix.ts` watches the phone's position from
--      the moment the visit form opens and keeps the sharpest reading; `position.timestamp` — the
--      instant the phone itself took that reading — is read on arrival and then dropped. What the
--      save stores is `captured_at`, the moment the TAP reached the server. The two are not the
--      same: a kept reading is replaced only by a sharper one or once it is 15 seconds old
--      (`STALE_MS`), and when no further reading arrives the kept one stays as long as the form is
--      open. So `captured_at` has been the only clock on the row, and module memory is explicit
--      that `captured_at` must not be read as a position in time.
--      `fix_taken_at` is that instant, and `fix_age_seconds` is how old the reading already was
--      when he tapped — both on the PHONE's clock, so their difference carries no clock skew even
--      on a handset whose clock is wrong. The skew against the server stays where it already is,
--      on `phoenix_crm_visits.device_skew_minutes`.
--
--   2. WHICH DEVICE SAVED IT. Nothing on a capture identified the device at all, so two reps
--      capturing from one phone was unanswerable. `device_install_id` is a random id the browser
--      keeps in its own storage — it names a browser install, never a person, never a handset's
--      serial, and it is cleared whenever the rep clears his site data. `app_revision` is the
--      SERVER's own deploy revision at save time, and `user_agent` is the request header: both are
--      read server-side, so neither can be reported falsely by a patched client.
--      🔴 NOT a package or APK scan — the owner forbids one by name.
--
-- 🔴 NOTHING HERE REFUSES A VISIT, FLAGS ONE, OR REACHES A REP. No value on this table is read by
-- the save, by any rep-facing screen, by `countedIntegrityFlags`, or by the Phoenix Ranks reader. It
-- is evidence for the Super Admin, in the shape the rest of this module already uses: written after
-- the save, never in front of it, and a failed write costs the rep nothing because his visit has
-- already returned.
--
-- WHY A SEPARATE TABLE AND NOT A `subject_kind` COLUMN. Only a VISIT is captured this way today. A
-- CHECK is the only record a column has of what may be in it, so a `subject_kind` admitting a place
-- or a venue that nothing writes would throw that record away for nothing — the same reasoning the
-- silent-detectors migration states for the one CHECK it did widen. A place's provenance, if it is
-- ever wanted, is a migration of its own.
--
-- REVERSIBILITY: `drop table public.phoenix_crm_visit_capture_provenance;` restores the previous
-- schema exactly. Nothing references it, so the drop needs no cascade.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_visit_capture_provenance (
  -- One row per visit: the save writes it once and a re-save upserts rather than piling rows up.
  visit_id uuid primary key,
  seat_id text,
  rep_hr_id text,
  -- The Cairo business day the visit files under, copied so a read can group without re-deriving
  -- the 02:00 cut-off that `phoenix_crm_save_visit` applies.
  visit_date date,
  -- The server's own receipt — the same instant `phoenix_crm_visits.captured_at` carries, kept here
  -- so this row can be read and ordered without joining back to the visit.
  captured_at timestamptz not null,

  -- 1 ── when the phone took the position it sent (the phone's own clock).
  fix_taken_at timestamptz,
  -- How old that reading already was at the tap, in whole seconds, both ends on the phone's clock.
  -- Null is NOT MEASURED — an older bundle, or a phone that reported no timestamp — and must never
  -- be read as zero, which is a reading taken at the instant he tapped.
  fix_age_seconds integer check (fix_age_seconds is null or fix_age_seconds >= 0),

  -- 2 ── which device, and which build.
  -- A browser install's own random id. Not a person and not a handset: one phone whose site data is
  -- cleared answers with a new id, and two reps sharing one phone and one browser profile answer
  -- with the SAME id. That is the whole question it exists to make answerable.
  device_install_id text,
  -- The server's deploy revision at save time, and the request's User-Agent. Both server-read.
  app_revision text,
  user_agent text,

  is_test boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.phoenix_crm_visit_capture_provenance is
  'Phoenix CRM capture provenance: when the phone took the position it sent (fix_taken_at/fix_age_seconds) and which browser install and build saved it. Service role only; no rep-facing screen reads it, nothing here refuses or flags a visit. See src/lib/phoenix-crm/server/capture-provenance.ts.';

comment on column public.phoenix_crm_visit_capture_provenance.fix_age_seconds is
  'Seconds between the phone taking the position and the rep tapping Log visit — both on the phone''s clock, so no clock skew. NULL is NOT MEASURED, never 0.';

comment on column public.phoenix_crm_visit_capture_provenance.device_install_id is
  'A random id a browser install keeps in its own storage. Names a browser install, never a person and never a handset serial; cleared with the site data. Two reps on one browser profile share it.';

-- The two reads this table exists for: one device's captures across days ("who else saved from this
-- browser"), and one rep's own captures newest first.
create index if not exists phoenix_crm_visit_capture_provenance_device_idx
  on public.phoenix_crm_visit_capture_provenance (device_install_id, visit_date);
create index if not exists phoenix_crm_visit_capture_provenance_rep_idx
  on public.phoenix_crm_visit_capture_provenance (rep_hr_id, captured_at desc);

-- Locked to the service role in the same four statements every other table in this module states.
-- RLS denies every browser role outright; the revokes keep that true even if a future `alter default
-- privileges` hands `public` a blanket grant, which is the exact shape of the 2026-08-06 exposure.
alter table public.phoenix_crm_visit_capture_provenance enable row level security;
create policy phoenix_crm_visit_capture_provenance_service_role
  on public.phoenix_crm_visit_capture_provenance for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_capture_provenance from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_capture_provenance to service_role;

notify pgrst, 'reload schema';

commit;
