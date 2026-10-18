-- outstation_journey_stops
--
-- WHAT THIS CHANGES: adds two columns to public.outstation_expense_requests.
--   journey_stops   jsonb NOT NULL DEFAULT '[]' — the extra places of one journey, after the
--                   arrival photo: each with its own live photo, GPS position, the governorate that
--                   position reverse-geocodes to, and Google's road km from the previous photo and
--                   back to the residence.
--   journey_pricing jsonb NULL — the last chained-journey pricing (mode, every drive home to home,
--                   what each pays and why, the old single-destination figure, and the anti-abuse
--                   flags) so the approver reads exactly what priced the fuel.
-- WHY: owner rule 2026-10-18 — a car journey that moves governorate to governorate (home →
--   Fayoum overnight → Beni Suef → home) pays each drive once, one way, km × the fuel rate, for
--   drives between two governorates over 40 km; until now a trip could only be home → one place →
--   home, so the Beni Suef drive had nowhere to go. See src/lib/outstation/chained-journey.ts.
-- ROLLBACK: alter table public.outstation_expense_requests
--             drop column if exists journey_pricing, drop column if exists journey_stops;
--   Dropping loses every captured stop (their photos stay in storage). Additive change, no
--   existing row's value moves: every current row gets '[]' and NULL, which prices exactly as before.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  add column if not exists journey_stops jsonb not null default '[]'::jsonb,
  add column if not exists journey_pricing jsonb;

alter table public.outstation_expense_requests
  drop constraint if exists outstation_expense_requests_journey_stops_is_array;
alter table public.outstation_expense_requests
  add constraint outstation_expense_requests_journey_stops_is_array
  check (jsonb_typeof(journey_stops) = 'array');

comment on column public.outstation_expense_requests.journey_stops is
  'Extra stops of one journey after the arrival photo (owner rule 2026-10-18): live photo, GPS, governorate, Google road km from the previous photo and back home. Written only by the outstation service.';
comment on column public.outstation_expense_requests.journey_pricing is
  'Last chained-journey pricing snapshot: mode, every drive home to home with paid/why, the single-destination figure, anti-abuse flags. Written only by the outstation service.';

commit;

-- Timestamp 20261018231703 was minted to sort after every migration already on main.
