-- phoenix_crm_line_lookalike_answers
--
-- WHAT THIS CHANGES:
--   One new table, additive, rewriting and reading no existing row:
--     public.phoenix_crm_line_lookalike_answers — the Super Admin's answer to "is this waiting customer the
--     customer another line has validated?", one row per PAIR (the waiting row, the validated row).
--
-- WHY (owner, 2026-11-16):
--   "Deep audit and find similar customers in different reps, same area, different lines", then "same
--   customer diff rep same area diff line", and, asked as a choice, "Fix rule + review list": the same
--   doctor or account written another way on another line of the same area — a word spelled differently,
--   the words reordered, a middle name left out, the same phone — goes on a list the Super Admin confirms
--   one by one. "Nothing is validated without that confirmation."
--
--   Confirming validates the waiting row through the existing phoenix_crm_share_line_validation (no new
--   function); this table keeps who answered what, so a pair answered "Not the same" is never asked again
--   and a confirmed pair keeps its decider.
--
--   🔴 NO FOREIGN KEY, on purpose: an answer about a customer later merged away or dropped is INERT —
--   nothing reads a pair whose rows are not on the list — and a foreign key would take a lock on
--   phoenix_crm_customers, the busiest table of the module, for no protection the list needs.
--
--   🔴 THE UNIQUE INDEX IS PLAIN, NOT PARTIAL: the save is an upsert through PostgREST, whose
--   `on_conflict=` names columns with no WHERE (the place_match_answers migration's own note on this).
--
--   🔴 NOTHING THE REP RECEIVES READS THIS TABLE. It is the Super Admin's own record.
--
-- ROLLBACK:
--   -- SAFE: the table is new in this migration, so dropping it loses only answers written since it was
--   -- applied, and no other object depends on it. A customer it validated stays validated.
--   drop table if exists public.phoenix_crm_line_lookalike_answers;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration reads and rewrites no existing row.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_line_lookalike_answers (
  id uuid primary key default gen_random_uuid(),
  waiting_customer_id uuid not null,
  source_customer_id uuid not null,
  answer text not null,
  decided_by_hr_id text not null,
  decided_at timestamptz not null default now(),
  constraint phoenix_crm_line_lookalike_answers_pair_chk check (waiting_customer_id <> source_customer_id),
  constraint phoenix_crm_line_lookalike_answers_answer_chk check (answer in ('same', 'not_same')),
  constraint phoenix_crm_line_lookalike_answers_decider_chk check (length(trim(decided_by_hr_id)) > 0)
);

comment on table public.phoenix_crm_line_lookalike_answers is
  'Phoenix CRM: the Super Admin''s answer to "is this waiting customer the customer another line validated?" '
  '(owner, 2026-11-16, "Fix rule + review list"). One row per (waiting, validated) pair; same = confirmed and '
  'validated through phoenix_crm_share_line_validation, not_same = never asked again. An answer about a row '
  'that is gone is inert. Nothing a rep receives reads it.';

create unique index if not exists phoenix_crm_line_lookalike_answers_pair_uidx
  on public.phoenix_crm_line_lookalike_answers (waiting_customer_id, source_customer_id);

-- The list reads the whole table (one row per pair a human answered), so no other index.

alter table public.phoenix_crm_line_lookalike_answers enable row level security;
create policy phoenix_crm_line_lookalike_answers_service_role
  on public.phoenix_crm_line_lookalike_answers for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_line_lookalike_answers from public, anon, authenticated;
grant all on table public.phoenix_crm_line_lookalike_answers to service_role;

-- The table is brand new, so PostgREST would answer PGRST205 about it until its next own reload — and
-- the route reads and writes through PostgREST.
notify pgrst, 'reload schema';

commit;
