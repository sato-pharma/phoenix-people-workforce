-- incentive_shown_figures
--
-- WHAT THIS CHANGES: a new table, public.incentive_shown_figures. It holds one row for each distinct
--   incentive figure a person's own Incentive tab showed them, with the inputs it was worked from (the
--   semester, the months counted, the achievement, the Sato achievement on a Pedia split, the basic,
--   the payout) and when it was first and last shown. The figure columns are never rewritten: a changed
--   figure is a new row. Service role only. Nothing reads it to pay anyone.
-- WHY: enterprise audit REC-066 (F-PAY-007). The figure on the tab was worked out on every read and
--   kept nowhere, so a month a person disputes could not be answered with what they saw after a price
--   fix or a restated closing. Owner, 14 Nov 2026: save it when first shown, again only when it
--   changes; he reads the history, nobody else.
-- ROLLBACK: drop table public.incentive_shown_figures;  -- loses the stored history, nothing else reads it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: a new, empty table.

begin;
set local lock_timeout = '5s';

create table if not exists public.incentive_shown_figures (
  id                        uuid        primary key default gen_random_uuid(),
  hr_id                     text        not null
                                        references public.employees (hr_id) on update cascade on delete restrict,
  semester_label            text        not null,
  -- The months the figure counted, "YYYY-MM", in order.
  periods                   text[]      not null default '{}',
  line                      text,
  sales_scope               text,
  achievement_percent       numeric     not null,
  semester_sales            numeric     not null,
  semester_target           numeric     not null,
  basic_salary              numeric     not null,
  payout_egp                numeric     not null,
  payout_percentage         numeric,
  -- The Pedia split's two halves, or null on every other seat.
  pedia_split               jsonb,
  -- The notice the tab printed beside the figure (an incomplete semester), or null.
  window_notice             text,
  -- A hash of every column above but hr_id; a changed figure has a new fingerprint and a new row.
  fingerprint               text        not null,
  -- The running commit that worked it out, when the server knows it.
  app_revision              text,
  first_shown_at            timestamptz not null default now(),
  last_shown_at             timestamptz not null default now(),
  constraint incentive_shown_figures_person_figure_key unique (hr_id, fingerprint)
);

comment on table public.incentive_shown_figures is
  'Each distinct incentive figure a person''s own Incentive tab showed them, with its inputs '
  '(REC-066). The figure columns are never rewritten; only last_shown_at moves. Written only from the '
  'person''s own tab, never from a manager''s, a test account''s, a seat view or a preview session. '
  'Read by the Super Admin on Employee 360. Nothing pays from it. Service role only.';

create index if not exists incentive_shown_figures_person_idx
  on public.incentive_shown_figures (hr_id, first_shown_at desc);

-- Service role only: row security on, one policy for the service role, no grant to either browser role.
alter table public.incentive_shown_figures enable row level security;
revoke all on public.incentive_shown_figures from public, anon, authenticated;
grant select, insert, update on public.incentive_shown_figures to service_role;

drop policy if exists phx_incentive_shown_figures_service_role on public.incentive_shown_figures;
create policy phx_incentive_shown_figures_service_role
  on public.incentive_shown_figures
  for all
  to service_role
  using (true)
  with check (true);

commit;
