-- dispute_explanations_reason_list
--
-- WHAT THIS CHANGES:
--   1. New table public.dispute_explanations — one row per explained dispute case (a calendar day, a
--      deduction line, a daily deduction line): the reason chosen from the list (training, meeting,
--      double visit, something else), the half of the day it covers, the employee's own words, the
--      dates, the person named to confirm it, and that person's answer.
--   2. New column public.private_calendar_data_disputes.day_part ('whole' | 'am' | 'pm', default
--      'whole'), so an accepted half-day explanation clears only that half of the day.
--   Additive only: no existing row, constraint, grant or function is altered. Every existing calendar
--   request reads day_part = 'whole', which is what each of them meant.
--
-- WHY:
--   Owner, 2026-11-16: disputes arrived as free text ("something is wrong", "Manager Confirmation") that
--   told the reviewer nothing. An employee now EXPLAINS the day from a short list and names who can
--   confirm it; the manager answers first, then the Super Admin decides. The reason, the confirmer and
--   the answer need their own columns so the inbox can group, filter and show them.
--
-- ROLLBACK:
--   alter table public.private_calendar_data_disputes drop column if exists day_part;
--   drop table if exists public.dispute_explanations;
--   (Dropping loses the explanations written since; the calendar requests themselves keep their text,
--   because claim_text / claim_source_text are still filled from the same words.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.dispute_explanations (
    id uuid primary key default gen_random_uuid(),
    -- Which module the case lives in, and that module's own id for it (the calendar request's id, the
    -- deduction candidate's id, the daily dispute's id).
    case_kind text not null,
    case_ref text not null,
    -- One explanation sent for several days at once shares a group: the confirmer answers it once.
    group_id uuid not null default gen_random_uuid(),
    employee_hr_id text not null,
    employee_name text,
    reason_code text not null,
    day_part text not null default 'whole',
    detail_text text not null default '',
    dates date[] not null default '{}',
    confirmer_hr_id text,
    confirmer_name text,
    confirmation_status text not null,
    confirmation_note text,
    confirmed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint dispute_explanations_case_kind_check
        check (case_kind in ('calendar', 'deduction', 'daily')),
    constraint dispute_explanations_reason_check
        check (reason_code in ('training', 'meeting', 'double_visit', 'other')),
    constraint dispute_explanations_day_part_check
        check (day_part in ('whole', 'am', 'pm')),
    constraint dispute_explanations_confirmation_check
        check (confirmation_status in ('not_needed', 'awaiting', 'confirmed', 'declined')),
    -- "Something else" has no confirmer and is whole-day; every other reason names one.
    constraint dispute_explanations_confirmer_shape_check
        check (
            (reason_code = 'other' and confirmer_hr_id is null and confirmation_status = 'not_needed' and day_part = 'whole')
            or (reason_code <> 'other' and confirmer_hr_id is not null and confirmation_status <> 'not_needed')
        ),
    constraint dispute_explanations_answered_check
        check ((confirmation_status in ('confirmed', 'declined')) = (confirmed_at is not null)),
    constraint dispute_explanations_detail_length_check
        check (length(detail_text) <= 1000),
    constraint dispute_explanations_case_uidx unique (case_kind, case_ref)
);

comment on table public.dispute_explanations is
    'Why an employee says a disputed day or deduction should not count: a reason from the fixed list, the half of the day, his words, and the manager or Training Manager named to confirm it. One row per dispute case; the case''s own module keeps its decision.';

-- The confirmer's list: what is waiting for this person.
create index if not exists dispute_explanations_awaiting_confirmer_idx
    on public.dispute_explanations (confirmer_hr_id, created_at)
    where confirmation_status = 'awaiting';

create index if not exists dispute_explanations_group_idx
    on public.dispute_explanations (group_id);

-- Service role only: row security on, no policy, no grant to either browser role.
alter table public.dispute_explanations enable row level security;
revoke all on table public.dispute_explanations from public, anon, authenticated;
grant select, insert, update, delete on table public.dispute_explanations to service_role;

alter table public.private_calendar_data_disputes
    add column if not exists day_part text not null default 'whole';

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'private_calendar_data_disputes_day_part_check'
          and conrelid = 'public.private_calendar_data_disputes'::regclass
    ) then
        alter table public.private_calendar_data_disputes
            add constraint private_calendar_data_disputes_day_part_check check (day_part in ('whole', 'am', 'pm'));
    end if;
end $$;

comment on column public.private_calendar_data_disputes.day_part is
    'The half of the day the request explains: whole, am (morning only) or pm (afternoon only). An accepted half clears only that half.';

commit;

-- Timestamp 20261116234054 was minted to sort after every migration already on main.
