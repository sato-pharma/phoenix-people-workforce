-- add_offer_vacancy_pointer
--
-- WHAT THIS CHANGES:
--   Adds `offers.vacancy_id` — a nullable pointer from a job-offer letter to the open seat in
--   `position_vacancies` the letter was written against. Nothing is backfilled; every one of the
--   28 offers already on production reads null, which is the correct answer for a letter issued
--   before the seat was ever recorded.
--
-- WHY:
--   An accepted offer had nowhere to go. HR read the candidate's name, the title and the salary off
--   the Offers screen and retyped all three into Add Employee, then hunted the right vacancy by hand
--   among 44 open ones — 42 of which are Medical Representative, telling each other apart only by
--   line and area. The offer already knows the seat at the moment it is written; this column is the
--   only place that knowledge could be kept, and with it the accepted letter can carry the candidate
--   straight into the hire form with the seat already chosen.
--
--   The DIRECTION matters and is deliberate. `offers` may point at an org seat, which is HR data the
--   whole system shares. It still may not point at a CANDIDATE: the offers module is independent of
--   recruitment by the owner's instruction, because an offer may be issued to somebody who never
--   entered the ATS, and `tests/candidate-offer-pointer.test.ts` pins that. A vacancy is not a
--   candidate, and `position_vacancies` is not a recruitment table — `src/lib/employees/vacancy-closer.ts`
--   has always read it without touching recruitment or offers.
--
--   `on delete set null`, never cascade: deleting a vacancy row must never delete the letter a real
--   person was sent. The letter outlives the seat.
--
-- ROLLBACK:
--   alter table public.offers drop column if exists vacancy_id;
--   Reversible in full — the column is additive, nullable and unread by anything that exists today.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one nullable column, no backfill, no row rewritten.

begin;

alter table public.offers
  add column if not exists vacancy_id bigint references public.position_vacancies(id) on delete set null;

comment on column public.offers.vacancy_id is
  'The open seat in position_vacancies this offer was written against. Null for an offer issued '
  'without one, which every offer before 2026-09-29 is. Never a candidate pointer — the offers '
  'module stays independent of recruitment (tests/candidate-offer-pointer.test.ts).';

-- The one read this column has: "which offers are out against this seat". Partial, because a null
-- pointer is the common case and indexing it would be indexing almost the whole table.
create index if not exists offers_vacancy_id_idx
  on public.offers (vacancy_id)
  where vacancy_id is not null;

commit;
