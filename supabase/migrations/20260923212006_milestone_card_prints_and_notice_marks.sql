-- milestone_card_prints_and_notice_marks
--
-- WHAT THIS CHANGES: adds two tables the milestones module has never had —
--   public.milestone_card_prints  an append-only log of every card that was actually produced
--   public.milestone_notice_marks a per-viewer latch recording that somebody has SEEN an occasion
-- WHY: the owner asked for a record of what was printed ("build them as they are"), and for a
--   reminder that "keeps pumping whenever there is a new event" and stops "when I open it and the
--   system confirm I see it" (2026-09-23). The first needs a log; the second needs a latch, and
--   this repository has no acknowledgement primitive to borrow.
-- ROLLBACK: drop table public.milestone_notice_marks; drop table public.milestone_card_prints;
--   Both are new and nothing else reads them, so the drop is clean. It loses the print history,
--   which is the only copy — take it out with a select before dropping if anyone has used it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
--
-- ── THE NATURAL KEY OF ONE OCCASION, AND WHY IT IS NOT WHAT THE CARD SAYS ─────
--
-- An occasion is (subject_hr_id, period_spec, derived_on), where `derived_on` is what
-- `milestoneDate(hire, spec)` computed — the ARITHMETIC's date. The card lets whoever prints it
-- type a different date over the top, because the owner's own call wins over the arithmetic, and
-- that typed date is stored too, as `milestone_on`. If identity keyed on the typed date instead,
-- one keystroke would mint a second occasion and the reminder would start again for somebody
-- already congratulated.
--
-- A corrected `hire_date` DOES mint a new occasion, deliberately: the milestone genuinely moved,
-- and a card printed for the wrong date is a card worth printing again.

begin;

-- ── 1. What was printed ──────────────────────────────────────────────────────
--
-- APPEND-ONLY, AND A REPRINT IS A SECOND ROW. Not an upsert: "we printed this twice, three weeks
-- apart" is a fact worth keeping, and collapsing it would make the log answer a narrower question
-- than the one it was asked ("has this been done", instead of "what happened").
--
-- No foreign key to employees. HR_IDs are reused when a seat is refilled and records are edited;
-- a print is an event that happened, and it must survive the record it was about.

create table if not exists public.milestone_card_prints (
  id              uuid        primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Who the card was for, and the name that was actually set on it. Stamped at write time, never
  -- joined at read time: the card is a keepsake carrying a name somebody chose (a nickname, a
  -- shortened legal name), and a later join would report a different name than the sheet.
  subject_hr_id   text        not null,
  printed_name    text        not null,
  -- The hire date the arithmetic used. Kept so a later correction is visible as a difference
  -- rather than silently rewriting history.
  hire_date       date,

  -- `1m`, `1y`, `100d`, or `b` + the ordinal for a birthday (`b1`, `b4`).
  period_spec     text        not null,
  -- The identity date (the arithmetic) and the printed date (what the sheet said). See the header.
  derived_on      date        not null,
  milestone_on    date        not null,

  format          text        not null,
  variant         text        not null,
  file_name       text,
  -- Where the face came from. 'upload' is a picture handed in for that one card; knowing that is
  -- the difference between "the record has no photograph" and "somebody brought a better one".
  photo_source    text        not null,

  -- Who printed it. Stamped, for the same reason the subject's name is.
  actor_login_id  text,
  actor_hr_id     text,
  actor_name      text,

  constraint milestone_card_prints_spec_shape
    check (period_spec ~ '^(b[0-9]{1,3}|[0-9]{1,5}[dmy])$'),
  constraint milestone_card_prints_format_known
    check (format in ('pdf', 'png')),
  constraint milestone_card_prints_variant_known
    check (variant in ('trim', 'safe', 'bleed')),
  constraint milestone_card_prints_photo_source_known
    check (photo_source in ('record', 'upload', 'none')),
  constraint milestone_card_prints_subject_not_blank
    check (btrim(subject_hr_id) <> ''),
  constraint milestone_card_prints_name_not_blank
    check (btrim(printed_name) <> '')
);

comment on table public.milestone_card_prints is
  'Append-only log of every milestone or birthday card actually produced. A reprint is a second row, deliberately. Identity of one occasion is (subject_hr_id, period_spec, derived_on) — derived_on is the ARITHMETIC date, never the date typed over it on the card (that is milestone_on). Owner request, 2026-09-23.';
comment on column public.milestone_card_prints.derived_on is
  'The date milestoneDate(hire, spec) computed. THE IDENTITY of the occasion — never the printed date.';
comment on column public.milestone_card_prints.milestone_on is
  'The date the sheet actually carried, which whoever printed it may have typed by hand.';
comment on column public.milestone_card_prints.photo_source is
  'record | upload | none. An upload is a picture handed in for that one card.';

-- Three indexes, one per question that is actually asked of this table.
-- "Has this occasion been printed?" — the pump's read, and the badge on the due list.
create index if not exists milestone_card_prints_occasion_idx
  on public.milestone_card_prints (derived_on, subject_hr_id, period_spec);
-- "What have we ever printed for this person?"
create index if not exists milestone_card_prints_subject_idx
  on public.milestone_card_prints (subject_hr_id, derived_on desc);
-- "What was printed lately?"
create index if not exists milestone_card_prints_recent_idx
  on public.milestone_card_prints (created_at desc);

alter table public.milestone_card_prints enable row level security;

drop policy if exists phx_milestone_card_prints_service_role on public.milestone_card_prints;
create policy phx_milestone_card_prints_service_role
  on public.milestone_card_prints
  to service_role using (true) with check (true);

revoke all on table public.milestone_card_prints from anon, authenticated;
grant all on table public.milestone_card_prints to service_role;

-- Deliberately NO grant to anon or authenticated. Visibility here is application-scoped: the only
-- reader is a route that has already asserted `milestones`, which is Super Admin alone.

-- ── 2. Who has seen what ─────────────────────────────────────────────────────
--
-- THE LATCH THAT STOPS THE REMINDER. One row per viewer per occasion, written when that viewer
-- opens the milestones page. `on conflict do nothing`, so opening the page ten times is one mark
-- and the write is safe to fire on every mount.
--
-- PER VIEWER, not global: "have I been told" is a question about a person, and a second Super
-- Admin added later must still hear about the same occasion once.

create table if not exists public.milestone_notice_marks (
  seen_by_hr_id   text        not null,
  subject_hr_id   text        not null,
  period_spec     text        not null,
  derived_on      date        not null,
  seen_at         timestamptz not null default now(),

  constraint milestone_notice_marks_unique
    unique (seen_by_hr_id, derived_on, subject_hr_id, period_spec),
  constraint milestone_notice_marks_spec_shape
    check (period_spec ~ '^(b[0-9]{1,3}|[0-9]{1,5}[dmy])$'),
  constraint milestone_notice_marks_viewer_not_blank
    check (btrim(seen_by_hr_id) <> '')
);

comment on table public.milestone_notice_marks is
  'One row per viewer per milestone occasion, written when that viewer opens the milestones page. This is what stops the daily reminder: the owner chose opening the page as the acknowledgement ("when I open it and the system confirm I see it, this pumping stops", 2026-09-23). Idempotent — on conflict do nothing.';

-- The pump reads "everything this viewer has seen inside the window", so the viewer leads.
create index if not exists milestone_notice_marks_viewer_window_idx
  on public.milestone_notice_marks (seen_by_hr_id, derived_on);

alter table public.milestone_notice_marks enable row level security;

drop policy if exists phx_milestone_notice_marks_service_role on public.milestone_notice_marks;
create policy phx_milestone_notice_marks_service_role
  on public.milestone_notice_marks
  to service_role using (true) with check (true);

revoke all on table public.milestone_notice_marks from anon, authenticated;
grant all on table public.milestone_notice_marks to service_role;

commit;
