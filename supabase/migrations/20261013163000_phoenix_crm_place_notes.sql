-- phoenix_crm_place_notes · phoenix_crm_place_recommendations
--
-- WHAT THIS CHANGES:
--   Two new tables, both additive, neither rewriting a single existing row:
--     1. public.phoenix_crm_place_notes — a comment written about ONE place check, by the System
--        Administrator or by the district manager above that rep, with a flag saying whether the rep
--        may read it;
--     2. public.phoenix_crm_place_recommendations — one manager's recommendation on that same
--        subject, to validate it or not to validate it. One row per (subject, manager), replaced
--        when he changes his mind.
--
-- WHY:
--   Owner, 13 October 2026: "In every district manager account, build a tab in his sidebar that shows
--   the check places only for his team and make him able to comment. And when he comes to comment, he
--   can choose the rep see the comment or the rep doesn't see the comment. He can recommend to
--   validate, or he can recommend to not validate. But the final is for the system administrator
--   only. But don't show this on the screen."
--
--   So a district manager reads his own team's Place checks and writes two things against a row — a
--   comment and a recommendation — and NEITHER of them decides anything. The decision stays
--   `canDecideValidationReviews`, the Super Admin alone (owner, 2026-10-03), and his screen says
--   nothing at all about who decides.
--
--   🔴 WHY THIS IS NOT A COLUMN ON phoenix_crm_validation_reviews. That table holds EXACTLY ONE ROW
--   PER PLACE FOR ALL TIME — `phoenix_crm_validation_reviews_place_idx` is UNIQUE on place_id — and a
--   decision is UPDATED in place rather than appended (measured 2026-10-03, on a 23505 against real
--   data). A comment is many-per-place by its nature, and most of the places a manager comments on
--   have no review row at all: 598 of the module's first 643 validated places had never been looked
--   at by anybody. A column there would have to be invented for every one of them.
--
--   🔴 WHY THE SUBJECT IS A PLACE **OR** A VENUE AND NEVER BOTH. The Place checks page draws four
--   sections. Two of them are things that are validated or not — a place (`phoenix_crm_places`) and a
--   polyclinic (`phoenix_crm_shared_places`) — and those are the two a recommendation can honestly be
--   made about. The other two are consequences: a customer waiting to be captured again has no place
--   left to judge, and a decided review is already decided. A real FK to each of the two subjects,
--   with a CHECK that exactly one is set, keeps referential integrity that a polymorphic
--   (subject_kind, subject_id) pair would have thrown away.
--
--   🔴 WHY rep_visible IS NOT NULL WITH NO DEFAULT. Golden rule #1 is that the rep's app never lets
--   him feel he is being checked, and until today nothing a rep received named a person at all
--   (owner, 2026-10-03: "do not show the rep that a person is accepting or rejecting"). The owner
--   opened exactly one door in it on 13 October 2026 — a comment he or a manager deliberately marks
--   visible, attributed by ROLE and never by name, delivered silently on the customer with no bell,
--   no Telegram and no email. A default would let a note reach the field because nobody chose; so
--   there is none, and the writer must say which it is.
--
-- ROLLBACK:
--   -- SAFE: both tables are new in this migration, so dropping them loses only rows written since it
--   -- was applied, and no other object in the schema depends on either.
--   drop table if exists public.phoenix_crm_place_recommendations;
--   drop table if exists public.phoenix_crm_place_notes;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration rewrites not one existing row and reads none.

begin;
set local lock_timeout = '5s';

-- 1 ─ The comment ────────────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_place_notes (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one of these two is set: see the subject CHECK below.
  place_id uuid references public.phoenix_crm_places(id) on delete cascade,
  shared_place_id uuid references public.phoenix_crm_shared_places(id) on delete cascade,
  -- The customer the note is about. Always set for a place note (that is how the rep's own app finds
  -- it); null for a venue note, which is about a building and is on nobody's list.
  customer_id uuid references public.phoenix_crm_customers(id) on delete cascade,
  -- The territory the subject belongs to, carried so a read can be scoped to a manager's own team
  -- without joining back through the place on every query.
  seat_id text not null,
  is_test boolean not null default false,
  author_hr_id text not null,
  -- 'system_admin' or 'manager' — which is the ONE thing a rep is told about a note he may read, as
  -- a role and never as a name (owner, 2026-10-13).
  author_source text not null,
  body text not null,
  rep_visible boolean not null,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_place_notes_subject_chk
    check ((place_id is not null)::int + (shared_place_id is not null)::int = 1),
  constraint phoenix_crm_place_notes_customer_chk
    check (place_id is null or customer_id is not null),
  constraint phoenix_crm_place_notes_source_chk
    check (author_source in ('system_admin', 'manager')),
  constraint phoenix_crm_place_notes_body_chk
    check (btrim(body) <> '' and length(body) <= 1000)
);

comment on table public.phoenix_crm_place_notes is
  'Phoenix CRM: a comment written about one place check by the System Administrator or by the district '
  'manager above that rep (owner, 2026-10-13). rep_visible decides whether the rep may read it; when he '
  'may, he is told the author''s ROLE and never a name, silently on the customer — no notice of any kind.';

create index if not exists phoenix_crm_place_notes_place_idx
  on public.phoenix_crm_place_notes (place_id, created_at desc)
  where place_id is not null;

create index if not exists phoenix_crm_place_notes_venue_idx
  on public.phoenix_crm_place_notes (shared_place_id, created_at desc)
  where shared_place_id is not null;

-- The rep's own read: his seat's visible notes, newest first. Partial on rep_visible, because the
-- notes he may NOT read are the majority and must never be in the set this index serves.
create index if not exists phoenix_crm_place_notes_rep_idx
  on public.phoenix_crm_place_notes (seat_id, is_test, created_at desc)
  where rep_visible;

alter table public.phoenix_crm_place_notes enable row level security;
create policy phoenix_crm_place_notes_service_role
  on public.phoenix_crm_place_notes for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_place_notes from public, anon, authenticated;
grant all on table public.phoenix_crm_place_notes to service_role;

-- 2 ─ The recommendation ─────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_place_recommendations (
  id uuid primary key default gen_random_uuid(),
  place_id uuid references public.phoenix_crm_places(id) on delete cascade,
  shared_place_id uuid references public.phoenix_crm_shared_places(id) on delete cascade,
  customer_id uuid references public.phoenix_crm_customers(id) on delete cascade,
  seat_id text not null,
  is_test boolean not null default false,
  manager_hr_id text not null,
  recommendation text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_place_recs_subject_chk
    check ((place_id is not null)::int + (shared_place_id is not null)::int = 1),
  constraint phoenix_crm_place_recs_customer_chk
    check (place_id is null or customer_id is not null),
  constraint phoenix_crm_place_recs_value_chk
    check (recommendation in ('validate', 'reject'))
);

comment on table public.phoenix_crm_place_recommendations is
  'Phoenix CRM: one manager''s recommendation on a place check — validate it, or do not validate it '
  '(owner, 2026-10-13). It decides NOTHING: the decision is the Super Admin''s alone '
  '(canDecideValidationReviews). One row per subject per manager, replaced when he changes his mind.';

-- One recommendation per manager per subject — one index per subject kind, because the subject lives
-- in one of two nullable columns.
--
-- 🔴 NEITHER INDEX IS PARTIAL, AND THAT IS NOT A LOOSE END. `where place_id is not null` reads as the
-- tidier shape and would break the write: Postgres can infer a PARTIAL index for ON CONFLICT only
-- when the inference specification repeats the predicate, and PostgREST's `on_conflict=` emits column
-- names with no WHERE at all — so the upsert would fail with "no unique or exclusion constraint
-- matching the ON CONFLICT specification" on every save. Plain indexes are also CORRECT here, because
-- the subject CHECK above means every row has exactly one non-null subject: a venue row carries
-- place_id null, NULLs never collide, and the venue index is the one that holds it to one row.
create unique index if not exists phoenix_crm_place_recs_place_uidx
  on public.phoenix_crm_place_recommendations (place_id, manager_hr_id);

create unique index if not exists phoenix_crm_place_recs_venue_uidx
  on public.phoenix_crm_place_recommendations (shared_place_id, manager_hr_id);

alter table public.phoenix_crm_place_recommendations enable row level security;
create policy phoenix_crm_place_recommendations_service_role
  on public.phoenix_crm_place_recommendations for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_place_recommendations from public, anon, authenticated;
grant all on table public.phoenix_crm_place_recommendations to service_role;

-- Both tables are brand new, so PostgREST would answer PGRST205 about them until its next own
-- reload — and the two routes write through PostgREST.
notify pgrst, 'reload schema';

commit;
