-- phoenix_crm_behaviour_integrity
--
-- WHAT THIS CHANGES:
--   One new table, public.phoenix_crm_behaviour_integrity — one row per rep per month, holding the
--   shape of that month's work: durations that never vary, a metronomic cadence, a burst nobody
--   could enter, a day that is always short, a list covered with nothing sold behind it, an outcome
--   that is never once a negative.
--
-- WHY (owner, 2026-09-25, Golden Rule #1: "close this hole whithout reps knowing"):
--   The position checks judge one fix and the photo sweep judges one picture. Both can be satisfied
--   by a rep who walks to one real place and enters twelve real-looking visits from the pavement
--   outside. What gives that away is the SHAPE OF A MONTH, which no per-capture detector can see.
--
--   THE REP IS NEVER TOLD. Nothing writes here on a rep's request, nothing he can open reads it, and
--   no number or word on his own screens changes because a row exists. The audience is the Super
--   Admin and the SFE Manager, on the board they already have.
--
-- WHY A TABLE OF ITS OWN, AND NOT A SOURCE ON phoenix_crm_location_integrity:
--   That table is keyed by CAPTURE — (subject_kind, subject_id, source). A behaviour verdict is not
--   about a capture: it is about a rep and a month, and it is RECOMPUTED WHOLE every sweep as more
--   of the month lands. Forcing it into a per-capture key would mean inventing a subject for it.
--   The board reads both tables and prints them together.
--
-- WHY measured IS A COLUMN AND NOT AN ABSENCE:
--   Every rule this table records is a statistical claim, and a claim over nine visits is a guess
--   with a number attached. A month below the floor is stored with measured = false — NOT CHECKED,
--   which must never read as clean: a rep on leave for three weeks cannot appear beside a rep who
--   spent the month on his sofa.
--
-- ROLLBACK:
--   drop table if exists public.phoenix_crm_behaviour_integrity;
--
-- Verification after apply:
--   select count(*) from public.phoenix_crm_behaviour_integrity;                        -- 0
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_behaviour_integrity';  -- t

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_behaviour_integrity (
  id uuid primary key default gen_random_uuid(),
  month text not null,
  rep_hr_id text not null,
  seat_id text,
  visits integer not null default 0,
  -- False when the month was too thin to carry a claim. NOT CHECKED is not clean.
  measured boolean not null default false,
  flags text[] not null default '{}',
  -- True when at least one individually damning flag fired, so the board sorts on one column.
  strong boolean not null default false,
  -- The numbers behind the flags. Deliberately carries no money: the sales rule stores whether the
  -- area saw sales, never how much, so a masked distributor's figure cannot reach a signals blob.
  signals jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint phoenix_crm_behaviour_integrity_month check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint phoenix_crm_behaviour_integrity_visits check (visits >= 0),
  constraint phoenix_crm_behaviour_integrity_person unique (month, rep_hr_id, is_test)
);

comment on table public.phoenix_crm_behaviour_integrity is
  'Phoenix CRM behaviour evidence, one row per rep per month, recomputed whole each nightly sweep. Service role only; no rep-facing screen reads it. See src/lib/phoenix-crm/behaviour-integrity.ts.';
comment on column public.phoenix_crm_behaviour_integrity.measured is
  'False when the month held too few visits to judge. NOT CHECKED, which is not the same as clean.';

-- The board's read: the strongest, most recent months first.
create index if not exists phoenix_crm_behaviour_integrity_board_idx
  on public.phoenix_crm_behaviour_integrity (strong desc, month desc);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role, which is a member of it, so the grant that follows is mandatory
-- rather than decorative; the `drop policy if exists` is what lets this file be REPLAYED against a
-- database whose schema already has it but whose ledger does not.
alter table public.phoenix_crm_behaviour_integrity enable row level security;
drop policy if exists phoenix_crm_behaviour_integrity_service_role on public.phoenix_crm_behaviour_integrity;
create policy phoenix_crm_behaviour_integrity_service_role
  on public.phoenix_crm_behaviour_integrity for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_behaviour_integrity from public, anon, authenticated;
grant all on table public.phoenix_crm_behaviour_integrity to service_role;

notify pgrst, 'reload schema';

commit;
