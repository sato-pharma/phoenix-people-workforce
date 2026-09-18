-- outstation_departure_location_refusals
--
-- WHAT THIS CHANGES: adds public.outstation_expense_requests.departure_location_refusals, a jsonb
--   array, default '[]', not null. No existing value changes: every row reads '[]' after this.
--
-- WHY: since 2026-09-18 a departure photo with no GPS location is refused and nothing is stored
--   (owner ruling "Refuse the photo", src/lib/outstation/departure-photo-location.ts). The owner
--   then chose "Record refused tries": each refusal is saved on the request with its time and cause
--   (location turned off, no signal in time, and so on), and the approver sees it where the
--   departure photo would be. Each element is {"at": "<ISO time>", "reason": "<code>"}; the codes
--   and their words live in src/lib/outstation/departure-location-refusals.ts, which also caps the
--   list to the newest 20.
--
--   The code reads the column defensively (a missing column reads as no refused tries) and writes it
--   best effort, so a deploy that lands before this migration refuses photos exactly as before.
--
-- ROLLBACK: alter table public.outstation_expense_requests
--             drop column if exists departure_location_refusals;
--   That discards every recorded refused try. Nothing else reads the column.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  add column if not exists departure_location_refusals jsonb not null default '[]'::jsonb;

comment on column public.outstation_expense_requests.departure_location_refusals is
  'Departure photos refused for having no GPS location, oldest first, newest 20 kept: [{"at": ISO time, "reason": code}]. Codes and their words: src/lib/outstation/departure-location-refusals.ts. Shown to the approver only.';

commit;
