-- phoenix_crm_place_match_answers
--
-- WHAT THIS CHANGES:
--   One new table, additive, rewriting and reading no existing row:
--     public.phoenix_crm_place_match_answers — the Super Admin's answer to "are these two validations
--     the same place?", one row per PAIR of validations.
--
-- WHY (owner, 2026-10-17):
--   "make a third tab in the same page … a place validated by more than a rep … put the validations
--   beside each other … which one is the most accurate … if you are in doubt of a place, ask — but not
--   every place; what is clear and confident, put it direct … I'm talking here about the admin only …
--   that you doubt that those two or those three validations are for the same place."
--
--   The Place checks page now groups every place (and every polyclinic) that two or more reps validated
--   at the same door. Where the two readings are close enough for the system to be CONFIDENT they are
--   one place, it groups them with no question; where they are clearly apart it never shows them; only
--   in between does it ask — and this table is where his answer is kept, so he is never asked twice.
--
--   🔴 WHY A PAIR, AND WHY TEXT KEYS WITH NO FOREIGN KEY. A validation is either a place
--   (`phoenix_crm_places`) or a polyclinic (`phoenix_crm_shared_places`), and an answer is about TWO of
--   them whichever kinds they are — four nullable foreign keys and two exactly-one CHECKs would have
--   said the same thing with more ways to be wrong. The key is `place:<uuid>` or `venue:<uuid>`, the
--   shape is held by a CHECK, and an answer about a validation that is later retired or merged away is
--   INERT: nothing reads a pair whose subject is not on the board. The pair is stored ORDERED
--   (subject_a < subject_b) so "A with B" and "B with A" are one row, whichever way round he was asked.
--
--   🔴 THE UNIQUE INDEX IS PLAIN, NOT PARTIAL, on purpose: the save is an upsert through PostgREST,
--   whose `on_conflict=` emits column names with no WHERE, and Postgres infers a partial index only when
--   the predicate is repeated (the place_notes migration's own note on this).
--
--   🔴 NOTHING THE REP RECEIVES READS THIS TABLE. It is the Super Admin's own working record about how
--   two reps' validations compare; it moves no KPI, no notice and no list.
--
-- ROLLBACK:
--   -- SAFE: the table is new in this migration, so dropping it loses only answers written since it was
--   -- applied, and no other object depends on it.
--   drop table if exists public.phoenix_crm_place_match_answers;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration reads and rewrites no existing row.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_place_match_answers (
  id uuid primary key default gen_random_uuid(),
  subject_a text not null,
  subject_b text not null,
  answer text not null,
  decided_by_hr_id text not null,
  decided_at timestamptz not null default now(),
  constraint phoenix_crm_place_match_answers_shape_chk
    check (
      subject_a ~ '^(place|venue):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and subject_b ~ '^(place|venue):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
  constraint phoenix_crm_place_match_answers_order_chk check (subject_a < subject_b),
  constraint phoenix_crm_place_match_answers_answer_chk check (answer in ('same', 'different'))
);

comment on table public.phoenix_crm_place_match_answers is
  'Phoenix CRM: the Super Admin''s answer to "are these two validations the same place?" (owner, 2026-10-17). '
  'One row per ordered pair of place:<uuid> / venue:<uuid> keys; an answer about a validation that is gone is '
  'inert. Nothing a rep receives reads it.';

create unique index if not exists phoenix_crm_place_match_answers_pair_uidx
  on public.phoenix_crm_place_match_answers (subject_a, subject_b);

-- The board reads the whole table (it is small: one row per pair a human answered), so no other index.

alter table public.phoenix_crm_place_match_answers enable row level security;
create policy phoenix_crm_place_match_answers_service_role
  on public.phoenix_crm_place_match_answers for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_place_match_answers from public, anon, authenticated;
grant all on table public.phoenix_crm_place_match_answers to service_role;

-- The table is brand new, so PostgREST would answer PGRST205 about it until its next own reload — and
-- the route reads and writes through PostgREST.
notify pgrst, 'reload schema';

commit;
