-- WHAT   A private evidence table for Phoenix CRM location integrity: one row per visit or place
--        capture that carried a mock-location signal or failed one of the server's own physics and
--        precision checks, with the numbers behind the call.
--
-- WHY    A "Fake GPS" app feeds Android any coordinate its owner picks, and nothing in Phoenix
--        marked it. Every other proof on a visit survives spoofing — the photo is live, the clock is
--        checked, the upload slot is single-use — but the position does not, and the position is
--        what the 300 m check and every territory number rest on. A faked PLACE is worse still: it
--        becomes the reference point every later visit is measured against.
--
--        The rep is never told (owner, 2026-09-25). This is a SEPARATE table rather than columns on
--        `phoenix_crm_visits` precisely so that no screen a rep can open is even capable of
--        selecting it: the visit row he reads back is byte-for-byte what it was before this
--        migration. RLS is on with NO policy and the browser roles are revoked, so the evidence is
--        reachable only by the service role — i.e. by the server, for the Super Admin's board.
--
-- ROLLBACK
--        drop table if exists public.phoenix_crm_location_integrity;
--        The table is additive and nothing reads it until the integrity board ships, so dropping it
--        loses only the evidence collected since it was applied. No existing row, column, function
--        or grant is touched by this migration, so there is nothing else to undo.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_location_integrity (
  id uuid primary key default gen_random_uuid(),
  -- Which capture this judges. A place is the higher-value target of the two: spoof it once and
  -- every visit measured against it reads "ok" for as long as the customer is on the list.
  subject_kind text not null check (subject_kind in ('visit', 'place')),
  subject_id uuid not null,
  seat_id text,
  rep_hr_id text,
  customer_id uuid,
  captured_at timestamptz not null,
  -- The Cairo day the capture files under, copied so the board can group without re-deriving it.
  visit_date date,
  lat double precision,
  lon double precision,
  accuracy_meters numeric,
  -- Android's own mock-provider flag, as expo-location reports it. Null where it does not exist:
  -- the web and iOS. Null is "we could not ask", never "clean".
  device_mocked boolean,
  flags text[] not null default '{}',
  -- True when at least one individually damning flag fired, so the board can sort on one column.
  strong boolean not null default false,
  signals jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  -- One verdict per capture: a later sweep that re-runs the detectors over history upserts rather
  -- than piling second opinions on the same visit.
  unique (subject_kind, subject_id)
);

comment on table public.phoenix_crm_location_integrity is
  'Phoenix CRM mock-location and GPS-plausibility evidence. Service role only; no rep-facing screen reads it. See src/lib/phoenix-crm/location-integrity.ts.';

-- The board's two reads: newest strong cases first, and one rep's history.
create index if not exists phoenix_crm_location_integrity_strong_idx
  on public.phoenix_crm_location_integrity (strong, captured_at desc);
create index if not exists phoenix_crm_location_integrity_rep_idx
  on public.phoenix_crm_location_integrity (rep_hr_id, captured_at desc);

-- Locked to the service role, in the same four statements every other table in this module states.
-- RLS denies every browser role outright; the revokes make that true even if a future `alter default
-- privileges` hands `public` a blanket grant, which is the exact shape of the 2026-08-06 exposure.
-- The policy names the service role explicitly rather than leaving RLS policy-less: policy-less is
-- equally closed today, but it reads as an omission, and `tests/phoenix-crm-boundary.test.ts` holds
-- every table in the module to the same four lines so that no table is locked by accident.
alter table public.phoenix_crm_location_integrity enable row level security;
create policy phoenix_crm_location_integrity_service_role
  on public.phoenix_crm_location_integrity for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_location_integrity from public, anon, authenticated;
grant all on table public.phoenix_crm_location_integrity to service_role;

notify pgrst, 'reload schema';

commit;
