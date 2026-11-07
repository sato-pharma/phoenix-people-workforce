-- "No ticket" trips (owner, 2026-11-07): the Submit Expense trip is now chosen as Fuel, Ticket or No ticket.
-- Fuel is stored as 'car' and Ticket as 'train', so nothing already stored changes meaning; a No-ticket trip
-- is the new value 'no_ticket', priced by the server at the fixed second-class AC train fare between the
-- stations nearest the home and the destination, there and back (src/lib/outstation/train-fare.ts).
--
-- Additive only: the check constraint is widened by one value, and one nullable column is added. No row
-- is read, moved or rewritten.

alter table public.outstation_expense_requests
  drop constraint if exists outstation_expense_requests_transportation_type_check;

alter table public.outstation_expense_requests
  add constraint outstation_expense_requests_transportation_type_check
  check (transportation_type in ('car', 'train', 'bus', 'other', 'no_ticket'));

alter table public.outstation_expense_requests
  add column if not exists no_ticket_fare jsonb;

comment on column public.outstation_expense_requests.no_ticket_fare is
  'A No-ticket trip''s fixed train fare as priced at submit: the boarding and alighting stations (English and '
  'Arabic), their distance from the home and the destination, the one-way and there-and-back fare in EGP, and '
  'the fare sweep it came from. Null on every other trip.';
