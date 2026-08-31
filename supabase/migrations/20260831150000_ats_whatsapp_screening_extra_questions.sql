-- Recruitment / ATS — Super-Admin-defined extra screening questions, asked after the fixed six.
--
-- WHY. The WhatsApp CV bot has always asked a hardcoded sequence (role, background, region, area,
-- experience, salary) — adding a question has always meant a code change, a PR and a deploy. The
-- owner asked "how to control questions?" and picked the most ambitious option: a Super-Admin-only
-- screen where he can add brand-new questions from scratch, tappable or free text, with no code
-- change ever needed again.
--
-- The existing six stay exactly as they are — still hardcoded, still writing their own dedicated
-- `ats_candidates` columns. `candidate-role-family.ts` and `candidate-region.ts`, the vocabularies
-- behind role/region/area, are read far beyond this bot (pool filters, org-scoped pickers,
-- cv-database-manager.tsx), so genericizing them would risk producing answers other parts of the
-- app cannot interpret. Nothing found a similar dependency on background/experience/salary, so this
-- migration adds a SEPARATE, purely additive path: once the fixed six finish, the flow optionally
-- continues into an ordered, admin-defined list of extra questions, stored generically because
-- future questions are unbounded and unknown ahead of time.
--
-- Three changes, all additive:
--
-- 1. ats_whatsapp_screening_questions — one row per admin-defined question. `question_key` is the
--    stable slug every answer is filed under; it is made IMMUTABLE by a trigger below, because a
--    later rename must never orphan history already collected under the old key. A question that
--    any real candidate has answered is retired via `is_active = false`, never deleted (the
--    app-level guard lives in the admin domain service; this migration adds no delete restriction
--    of its own, matching every other admin-owned table in this schema).
--
-- 2. Two columns on the session, `extra_current_question_key` and `extra_answers`, mirroring the
--    shape the fixed six already use (a code/key column plus a bag of collected answers). The `step`
--    CHECK constraint is replaced with a strict superset adding one value, `'extra'` — dropped and
--    recreated rather than widened, because Postgres has no "alter check constraint". Every existing
--    row still satisfies it unchanged.
--
-- 3. One column on the candidate, `screening_extra_answers`, keyed by `question_key`. Deliberately
--    separate from `position_specific_fields` (CV-extraction data, a different meaning, already
--    consumed by cv-field-storage.ts) — the two must never be conflated.
--
-- No existing row is read, rewritten or moved. In-flight conversations are untouched: the new
-- columns are nullable/defaulted and the new step only extends the tail. Reversible: drop the new
-- table and the three new columns, and restore the previous 11-value step constraint. Rolling back
-- with a row already parked on `extra` would strand it, so the constraint is replaced only after the
-- columns exist — same ordering discipline as the prior step-extension migration.

begin;

-- ── 1. The admin-defined question definitions ───────────────────────────────────────────────────

create table if not exists public.ats_whatsapp_screening_questions (
  id uuid primary key default gen_random_uuid(),
  question_key text not null,
  body_text text not null,
  kind text not null,
  options jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ats_whatsapp_screening_questions_kind_check
    check (kind in ('tappable', 'free_text')),
  -- Mirrors WHATSAPP_BODY_MAX (1024) from whatsapp-classify-menus.ts — the same constant every one
  -- of the fixed six questions is checked against before it can be sent.
  constraint ats_whatsapp_screening_questions_body_length
    check (char_length(body_text) <= 1024),
  -- A slug the admin UI generates once and a session row later stores verbatim as the answers-bag
  -- key. Lowercase and underscored so it can never collide with the classify flow's own `phx:` row
  -- id namespace, which uses colons.
  constraint ats_whatsapp_screening_questions_key_format
    check (question_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- `options` exists iff `kind = 'tappable'`, and mirrors WHATSAPP_LIST_MAX_ROWS (10) — one array
  -- element per WhatsApp list row. Per-element title/description length limits are NOT expressible
  -- as a plain Postgres CHECK (no subqueries over jsonb array elements); that enforcement stays in
  -- TypeScript (screeningQuestionViolations), the same precedent the fixed six already set — none of
  -- their per-row length limits are database constraints either.
  constraint ats_whatsapp_screening_questions_options_shape
    check (
      (kind = 'free_text' and options is null)
      or (
        kind = 'tappable'
        and options is not null
        and jsonb_typeof(options) = 'array'
        and jsonb_array_length(options) between 1 and 10
      )
    )
);

create unique index if not exists ats_whatsapp_screening_questions_key_key
  on public.ats_whatsapp_screening_questions (question_key);

create index if not exists ats_whatsapp_screening_questions_active_idx
  on public.ats_whatsapp_screening_questions (is_active, sort_order);

comment on table public.ats_whatsapp_screening_questions is
  'Super-Admin-defined questions asked over WhatsApp after the fixed six (role/background/region/area/experience/salary) finish. Answers are stored on ats_candidates.screening_extra_answers, keyed by question_key.';
comment on column public.ats_whatsapp_screening_questions.question_key is
  'Immutable slug (enforced by ats_whatsapp_screening_questions_immutable_key below) — the key every collected answer is filed under. Never reused: retire with is_active = false, never delete a question with real answers.';
comment on column public.ats_whatsapp_screening_questions.options is
  'For kind = tappable: a JSON array of {value, title, description?}, 1-10 elements. Null for free_text.';

-- question_key is the join key for every answer ever collected under it. A rename would silently
-- orphan history the moment an old key stops resolving to a label — so it is not just an app-level
-- rule, it is enforced here.
create or replace function public.ats_whatsapp_screening_questions_immutable_key()
returns trigger
language plpgsql
as $$
begin
  if new.question_key is distinct from old.question_key then
    raise exception 'ats_whatsapp_screening_questions.question_key is immutable (was %, tried to set %)',
      old.question_key, new.question_key;
  end if;
  return new;
end;
$$;

drop trigger if exists ats_whatsapp_screening_questions_immutable_key_trigger
  on public.ats_whatsapp_screening_questions;
create trigger ats_whatsapp_screening_questions_immutable_key_trigger
  before update on public.ats_whatsapp_screening_questions
  for each row execute function public.ats_whatsapp_screening_questions_immutable_key();

alter table public.ats_whatsapp_screening_questions enable row level security;

-- Matches every other ats_ table: application-scoped visibility, service_role only at the database.
drop policy if exists phx_ats_whatsapp_screening_questions_service_role on public.ats_whatsapp_screening_questions;
create policy phx_ats_whatsapp_screening_questions_service_role
  on public.ats_whatsapp_screening_questions
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.ats_whatsapp_screening_questions to service_role;

-- ── 2. Where the conversation's position and answers live ──────────────────────────────────────

alter table public.ats_whatsapp_classification_sessions
  add column if not exists extra_current_question_key text,
  add column if not exists extra_answers jsonb not null default '{}'::jsonb;

comment on column public.ats_whatsapp_classification_sessions.extra_current_question_key is
  'Which admin-defined question is outstanding — a KEY, not a positional index, so a mid-flight reorder or deactivation of another question cannot strand this conversation. Null outside the extra-question loop.';
comment on column public.ats_whatsapp_classification_sessions.extra_answers is
  'Answers collected so far in the extra-question loop, keyed by question_key. Copied verbatim onto ats_candidates.screening_extra_answers when the loop finishes.';

alter table public.ats_whatsapp_classification_sessions
  drop constraint if exists ats_whatsapp_classification_sessions_step_check;

alter table public.ats_whatsapp_classification_sessions
  add constraint ats_whatsapp_classification_sessions_step_check
    check (step in (
      'job_title', 'job_title_other',
      'background', 'background_other',
      'region', 'region_other',
      'area', 'area_other',
      'experience', 'salary',
      'extra',
      'done'
    ));

comment on column public.ats_whatsapp_classification_sessions.step is
    'Outstanding question: job_title -> (job_title_other) -> background -> (background_other) -> region -> (region_other) -> area -> (area_other) -> experience -> salary -> extra -> done. The bracketed steps and salary are typed (no menu). The area step is reached only by a Medical Rep. extra is the admin-defined question loop, entered only when at least one active question exists at the moment salary finishes; a session that never sees an active question goes straight from salary to done, exactly as before this migration.';

-- ── 3. Where the finished answers land on the candidate ─────────────────────────────────────────

alter table public.ats_candidates
  add column if not exists screening_extra_answers jsonb not null default '{}'::jsonb;

comment on column public.ats_candidates.screening_extra_answers is
  'Answers to the Super-Admin-defined WhatsApp screening questions, keyed by question_key. Written only by the WhatsApp self-classification flow, once the extra-question loop finishes. Distinct from position_specific_fields, which is CV-extraction data (cv-field-storage.ts) — the two must never be conflated.';

commit;
