-- marketing_functions_and_field_feedback
--
-- WHAT THIS CHANGES: three new tables for the Product Manager's two sheets (src/lib/marketing-functions/).
--   * public.marketing_function_months: one row per Product Manager per month, the Monthly Marketing
--     Functions sheet. Status moves draft (his) -> submitted -> reviewed (locked); a reviewer may reopen.
--   * public.marketing_function_items: one row per item on that sheet, in one of the eight fixed
--     categories of the Group Product Manager's workbook, with Item Description, Due Date, whether it was
--     planned at the start of the month or added as actual, and Status/ mid month and Status/ end of month.
--   * public.marketing_field_feedback: one Marketing Field Visit Feedback form per single or double
--     visit with a Medical Rep: the header (rep, job title and area as they were on the day, date, AM and
--     PM clinics and pharmacies visited, kept as three separate figures), the objectives, the eleven call
--     remarks rated excellent / good / average / poor, comments, doctors' comments, recommendations, who
--     should act on them, and the signature (signed_at), which locks the form.
-- WHY: owner, 2026-11-10. Dr. Rasha Sabry (Group Product Manager) sent Dr. Ahmed Sharaf two sheets to use
--   from this month through 2027; the owner asked for them as a module with "same concept", "her exact
--   wording", "same colors". Product Managers fill both; the Group Product Manager reviews; the Marketing
--   Manager and the CEO read; the rep's own line National Sales Manager reads the feedback.
-- ROLLBACK: drop table public.marketing_function_items; drop table public.marketing_function_months;
--   drop table public.marketing_field_feedback; — all three are new and nothing outside
--   src/lib/marketing-functions/ reads them.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: three new, empty tables.

begin;

create table if not exists public.marketing_function_months (
  id                 uuid primary key default gen_random_uuid(),
  author_hr_id       text not null,
  -- The first day of the month the sheet is for.
  month              date not null,
  status             text not null default 'draft',
  submitted_at       timestamptz,
  submitted_by_hr_id text,
  reviewed_at        timestamptz,
  reviewed_by_hr_id  text,
  review_note        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint marketing_function_months_status_check check (status in ('draft', 'submitted', 'reviewed')),
  constraint marketing_function_months_first_day_check check (extract(day from month) = 1),
  constraint marketing_function_months_one_per_month unique (author_hr_id, month)
);

create table if not exists public.marketing_function_items (
  id           uuid primary key default gen_random_uuid(),
  month_id     uuid not null references public.marketing_function_months (id) on delete cascade,
  category_key text not null,
  product      text,
  description  text not null,
  due_date     date,
  -- planned: written as part of the month's plan; actual: added later, done though it was not planned.
  origin       text not null default 'planned',
  status_mid   text,
  note_mid     text,
  status_end   text,
  note_end     text,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint marketing_function_items_category_check check (
    category_key in ('planning', 'promotional', 'trainings', 'events', 'field', 'clinical', 'digital', 'admin')
  ),
  constraint marketing_function_items_origin_check check (origin in ('planned', 'actual')),
  constraint marketing_function_items_status_mid_check check (
    status_mid is null or status_mid in ('not_started', 'in_progress', 'done', 'postponed', 'cancelled')
  ),
  constraint marketing_function_items_status_end_check check (
    status_end is null or status_end in ('not_started', 'in_progress', 'done', 'postponed', 'cancelled')
  ),
  constraint marketing_function_items_description_check check (length(btrim(description)) > 0)
);

create index if not exists marketing_function_items_month_idx
  on public.marketing_function_items (month_id, category_key, sort);
create index if not exists marketing_function_months_month_idx
  on public.marketing_function_months (month, status);

create table if not exists public.marketing_field_feedback (
  id                  uuid primary key default gen_random_uuid(),
  author_hr_id        text not null,
  visit_type          text not null default 'double',
  rep_hr_id           text not null,
  -- As they were on the day of the visit, so a later transfer does not rewrite the form.
  rep_job_title       text,
  rep_area            text,
  rep_line            text,
  visit_date          date not null,
  am_clinics          integer,
  pm_clinics          integer,
  pharmacies          integer,
  objectives          text,
  ratings             jsonb not null default '{}'::jsonb,
  comments            text,
  doctors_comments    text,
  recommendations     text,
  action_owners       text[] not null default '{}'::text[],
  -- True when the header and the counts were filled from his logged Phoenix CRM ride-along day.
  from_crm_day        boolean not null default false,
  signed_at           timestamptz,
  signed_by_hr_id     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint marketing_field_feedback_visit_type_check check (visit_type in ('single', 'double')),
  constraint marketing_field_feedback_counts_check check (
    coalesce(am_clinics, 0) >= 0 and coalesce(pm_clinics, 0) >= 0 and coalesce(pharmacies, 0) >= 0
  ),
  constraint marketing_field_feedback_ratings_object_check check (jsonb_typeof(ratings) = 'object'),
  constraint marketing_field_feedback_action_owners_check check (
    action_owners <@ array['marketing', 'sales_manager', 'training']::text[]
  )
);

create index if not exists marketing_field_feedback_author_idx
  on public.marketing_field_feedback (author_hr_id, visit_date desc);
create index if not exists marketing_field_feedback_rep_idx
  on public.marketing_field_feedback (rep_hr_id, visit_date desc);

alter table public.marketing_function_months enable row level security;
alter table public.marketing_function_items enable row level security;
alter table public.marketing_field_feedback enable row level security;

-- Service role only: every read and write goes through the app's server routes, which check the seat
-- (marketing_functions / marketing_field_feedback) and then narrow by identity. Nothing in a browser
-- touches these tables.
drop policy if exists phx_marketing_function_months_service_role on public.marketing_function_months;
create policy phx_marketing_function_months_service_role
  on public.marketing_function_months for all to service_role using (true) with check (true);

drop policy if exists phx_marketing_function_items_service_role on public.marketing_function_items;
create policy phx_marketing_function_items_service_role
  on public.marketing_function_items for all to service_role using (true) with check (true);

drop policy if exists phx_marketing_field_feedback_service_role on public.marketing_field_feedback;
create policy phx_marketing_field_feedback_service_role
  on public.marketing_field_feedback for all to service_role using (true) with check (true);

revoke all on public.marketing_function_months from public, anon, authenticated;
revoke all on public.marketing_function_items from public, anon, authenticated;
revoke all on public.marketing_field_feedback from public, anon, authenticated;
grant select, insert, update, delete on public.marketing_function_months to service_role;
grant select, insert, update, delete on public.marketing_function_items to service_role;
grant select, insert, update, delete on public.marketing_field_feedback to service_role;

comment on table public.marketing_function_months is
  'Monthly Marketing Functions (src/lib/marketing-functions/): one sheet per Product Manager per month. Draft -> submitted -> reviewed (locked).';
comment on table public.marketing_function_items is
  'One item on a Monthly Marketing Functions sheet, in one of the Group Product Manager''s eight categories, with its mid-month and end-of-month status.';
comment on table public.marketing_field_feedback is
  'Marketing Field Visit Feedback: a Product Manager''s single or double visit with a Medical Rep, eleven call remarks rated excellent/good/average/poor. Signed forms are locked.';

do $$
begin
  if to_regclass('public.marketing_function_months') is null
     or to_regclass('public.marketing_function_items') is null
     or to_regclass('public.marketing_field_feedback') is null then
    raise exception 'marketing functions tables were not created';
  end if;
end $$;

commit;
