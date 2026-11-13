-- A RELEASED DAILY DEDUCTION CAN BE DISPUTED (owner, 2026-11-13).
--
-- The employee's Deductions page lists the daily deductions the Super Admin released during the month
-- ("Released during the month") with no Dispute button at all — the dispute box lived only on the
-- monthly ledger below it. Four of the seven employees holding a released line on 13 November had
-- nothing else on the page, so the email that told them the amount sent them to a page where they
-- could not argue with it.
--
-- His decision on what an accepted dispute does (multiple choice, the same day): "Withdraw + never
-- charge" — the released line is withdrawn, the days show verified on his calendar, and the month-end
-- deduction can never charge those days again, whatever the type.
--
-- Two tables, service-role only like every other dispute thread (the audience rule is application
-- code): the dispute keeps ITS OWN COPY of the line it argues with, because a withdrawn line is
-- deleted from the snapshot and a superseded snapshot cascades its lines away — the case must never
-- disappear with them (his 2026-10-09 rule: "never disappeared from me or the employee side").
--
-- The Dispute Center's shared tables learn the new kind, `daily`.

create table if not exists public.daily_deductions_disputes (
  id                      uuid primary key default gen_random_uuid(),
  -- The released line it was opened on. No foreign key: the line is deleted when it is withdrawn.
  line_id                 uuid not null,
  publication_id          uuid,
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  employee_name           text,
  category                text not null references public.deductions_categories(category),
  unit                    text not null default 'days',
  days_count              numeric(14, 2) not null default 0,
  amount                  numeric(14, 2) not null default 0,
  dates                   jsonb not null default '[]'::jsonb,
  range_start             date,
  range_end               date,
  reason                  text,
  -- The employee's opening words.
  claim_text              text not null,
  status                  text not null default 'open',
  decided_by_hr_id        text,
  decision_note           text,
  decided_at              timestamptz,
  created_by_hr_id        text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint daily_deductions_disputes_status_check check (status in ('open', 'accepted', 'rejected')),
  constraint daily_deductions_disputes_unit_check check (unit in ('days', 'amount')),
  constraint daily_deductions_disputes_claim_check check (length(btrim(claim_text)) > 0),
  constraint daily_deductions_disputes_employee_check check (btrim(employee_hr_id) <> '' and btrim(employee_hr_id_compact) <> ''),
  constraint daily_deductions_disputes_decided_check
    check ((status = 'open' and decided_at is null) or (status <> 'open' and decided_at is not null))
);

comment on table public.daily_deductions_disputes is
  'A dispute an employee raised on a RELEASED daily deduction line (owner, 2026-11-13). Keeps its own copy of the line, because a withdrawn line is deleted. Accepted = the line is withdrawn and month-end collection never charges those days for that category again (src/lib/daily-deductions/accepted-dispute-days.ts). Service-role only; the audience rule is in src/lib/dispute-center/daily.ts.';

-- One dispute per released line: a decided one is reopened through the Dispute Center, never opened twice.
create unique index if not exists daily_deductions_disputes_line_uidx on public.daily_deductions_disputes (line_id);
create index if not exists daily_deductions_disputes_employee_idx on public.daily_deductions_disputes (employee_hr_id_compact, created_at desc);
create index if not exists daily_deductions_disputes_status_idx on public.daily_deductions_disputes (status, category);

create table if not exists public.daily_deductions_dispute_messages (
  id                  uuid primary key default gen_random_uuid(),
  dispute_id          uuid not null references public.daily_deductions_disputes(id) on delete cascade,
  author_hr_id        text not null,
  author_is_reviewer  boolean not null default false,
  body                text not null,
  created_at          timestamptz not null default now(),
  constraint daily_deductions_dispute_messages_body_check check (length(btrim(body)) > 0)
);

comment on table public.daily_deductions_dispute_messages is
  'Every reply after the opening on a daily deduction dispute, from either side. Service-role only.';

create index if not exists daily_deductions_dispute_messages_dispute_idx
  on public.daily_deductions_dispute_messages (dispute_id, created_at);

alter table public.daily_deductions_disputes enable row level security;
alter table public.daily_deductions_dispute_messages enable row level security;

drop policy if exists daily_deductions_disputes_service_role_all on public.daily_deductions_disputes;
create policy daily_deductions_disputes_service_role_all
  on public.daily_deductions_disputes for all to service_role using (true) with check (true);
drop policy if exists daily_deductions_dispute_messages_service_role_all on public.daily_deductions_dispute_messages;
create policy daily_deductions_dispute_messages_service_role_all
  on public.daily_deductions_dispute_messages for all to service_role using (true) with check (true);

revoke all on table public.daily_deductions_disputes from anon, authenticated, public;
revoke all on table public.daily_deductions_dispute_messages from anon, authenticated, public;
grant all on table public.daily_deductions_disputes to service_role;
grant all on table public.daily_deductions_dispute_messages to service_role;

-- The Dispute Center's shared tables: the events, the pictures and the case briefings learn `daily`.
alter table public.dispute_case_events drop constraint if exists dispute_case_events_kind_check;
alter table public.dispute_case_events add constraint dispute_case_events_kind_check
  check (case_kind = any (array['calendar'::text, 'deduction'::text, 'digest'::text, 'daily'::text]));

alter table public.dispute_attachments drop constraint if exists dispute_attachments_kind_check;
alter table public.dispute_attachments add constraint dispute_attachments_kind_check
  check (case_kind = any (array['calendar'::text, 'digest'::text, 'daily'::text]));

alter table public.dispute_assist_entries drop constraint if exists dispute_assist_entries_kind_check;
alter table public.dispute_assist_entries add constraint dispute_assist_entries_kind_check
  check (case_kind = any (array['calendar'::text, 'deduction'::text, 'digest'::text, 'daily'::text]));
