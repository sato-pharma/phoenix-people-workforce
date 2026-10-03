-- WHAT   One row per Phoenix CRM capture the SERVER REFUSED on its location — the reading the phone
--        actually sent, the line it missed, and which of the two refusals it was. The accepted
--        captures have had a home since the first migration; the refused ones had none.
--
-- WHY    A refusal wrote NOTHING. `phoenix_crm_location_integrity` is filed after a save SUCCEEDS,
--        the place and the visit rows are never created, and the upload slot keeps only the fact
--        that a slot was asked for — so the number on which the refusal turned existed for one
--        instant on the rep's screen and nowhere else.
--
--        What that cost, on 2026-10-03: a rep met the rough-location refusal EIGHTEEN times between
--        16:12 and 18:47 Cairo, and answering "why her, and why that afternoon" took the upload
--        slots, the bytes in `storage.objects`, her four surviving MORNING readings and an off-line
--        reconstruction of Android's 2 km privacy grid. Her 2,000 m is knowable today only because
--        four captures of hers happened to be accepted earlier that morning, before the 100 m line
--        shipped at 11:24. Had the line been in place at 10:10 there would be no number anywhere.
--
--        The rep is still never told anything new (Golden Rule #1, owner 2026-09-26). This table is
--        written by the server and read by nobody below the Super Admin: RLS on with a service-role
--        policy, and the browser roles revoked, exactly as the integrity table is. It changes no
--        message, no screen and no figure — a refused capture is refused identically, in the same
--        words, and the only difference is that its number survives the refusal.
--
--        NOT keyed and NOT upserted, deliberately: eighteen attempts are eighteen rows. A unique
--        constraint on anything here would collapse the retry history, which IS the evidence.
--
-- ROLLBACK
--        drop table if exists public.phoenix_crm_refused_readings;
--        Additive in full: no existing table, column, view, function, policy or grant is touched, so
--        dropping it loses only the refusals recorded since it was applied. Nothing reads it except
--        SQL run by hand, so no screen breaks.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_refused_readings (
  id uuid primary key default gen_random_uuid(),
  -- Which door refused it. A PLACE is the costlier refusal of the two: the rep cannot work the
  -- customer at all until it lands, where a refused visit is one visit.
  subject_kind text not null check (subject_kind in ('visit', 'place')),
  -- 'no_fix'  — the phone sent no usable coordinate at all (permission off, or no position yet).
  -- 'rough'   — it sent a real coordinate whose radius was wider than the line below.
  reason text not null check (reason in ('no_fix', 'rough')),
  seat_id text,
  -- Whoever's phone was refused: the rep, or the manager or Super Admin entering for him.
  rep_hr_id text,
  -- Null where the refusal happened before a customer was chosen (adding a new one, or one met
  -- outside the list), which is legitimate and must not cost the row.
  customer_id uuid,
  refused_at timestamptz not null default now(),
  -- The Cairo VISIT day, which ends at 02:00 (owner, 2026-09-29) — passed in by the server, never
  -- derived here, because the database's own day is UTC.
  visit_date date,
  lat double precision,
  lon double precision,
  accuracy_meters numeric,
  -- The shutter's own reading, kept separately: a place is refused when EITHER number is wide, and
  -- which one it was is the first thing anybody asks.
  photo_lat double precision,
  photo_lon double precision,
  photo_accuracy_meters numeric,
  -- The line it had to be inside, stored with the row rather than looked up later: the line has
  -- moved once already (the place's 100 m shipped 2026-10-03) and a stored refusal must stay
  -- readable against the rule that actually refused it.
  max_accuracy_meters numeric,
  -- The phone's own clock at the capture, and Android's mock-provider flag. Both as reported, both
  -- nullable: the web and iOS cannot answer the second at all, and null is "not asked", never "clean".
  device_captured_at timestamptz,
  device_mocked boolean,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.phoenix_crm_refused_readings is
  'Phoenix CRM captures the server refused on their location, with the reading the phone sent. Service role only; no rep-facing screen reads it. See src/lib/phoenix-crm/server/refused-readings.ts.';

-- The two questions it exists to answer: "what is this rep being refused with?" and "who is being
-- refused right now?".
create index if not exists phoenix_crm_refused_readings_rep_idx
  on public.phoenix_crm_refused_readings (rep_hr_id, refused_at desc);
create index if not exists phoenix_crm_refused_readings_recent_idx
  on public.phoenix_crm_refused_readings (refused_at desc);

-- The same four statements every table in this module states; `tests/phoenix-crm-boundary.test.ts`
-- holds each one of them to exactly these lines, so that no table is ever locked by accident.
alter table public.phoenix_crm_refused_readings enable row level security;
create policy phoenix_crm_refused_readings_service_role
  on public.phoenix_crm_refused_readings for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_refused_readings from public, anon, authenticated;
grant all on table public.phoenix_crm_refused_readings to service_role;

notify pgrst, 'reload schema';

commit;
