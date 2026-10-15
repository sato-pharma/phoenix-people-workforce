-- ats_job_post_titles
--
-- WHAT THIS CHANGES: adds one table, public.ats_job_post_titles — the job titles the Job Posts page
-- builds its pictures from, each carrying its own "What you will do" and "What you need" lists and
-- the key facts printed on the post. Seeds the three HR roles in the owner's own final wording.
-- WHY: the owner asked (2026-10-15) for a recruitment page where he or Talent Acquisition picks or
-- adds a job title, writes the duties and requirements once, saved with the title, then chooses one
-- of five post templates and downloads the image. WHAT A JOB IS belongs to the title, never to a
-- design (recruitment rules, the same split offer_job_titles.role_summary follows): the five
-- templates are looks only and read every word from this row.
-- ROLLBACK: drop table public.ats_job_post_titles;  -- nothing else references it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is neither: one new table and three seed rows.

begin;

create table if not exists public.ats_job_post_titles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  department text not null default 'Human Resources',
  -- The optional two-line hero statement ("Lead the team behind / our people."). Null prints no
  -- statement — a template never invents one.
  headline text,
  reports_to text,
  employment text not null default 'Full-time',
  location text not null default 'Sheraton, Cairo',
  -- Each list is an array of {"lead": "...", "rest": "..."}: the bold opening of a line and the plain
  -- remainder, which is how every post the owner has approved sets a line. Order is the array order.
  duties jsonb not null default '[]'::jsonb,
  needs jsonb not null default '[]'::jsonb,
  -- The wording after "choose" on the post's WhatsApp line. Null means the title itself.
  menu_name text,
  is_active boolean not null default true,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The app's own limits, restated so a hand SQL edit cannot store a row the editor would refuse.
  -- Eight lines a list is what one 1080x1350 post holds at a readable size.
  constraint ats_job_post_titles_title_not_blank check (length(btrim(title)) > 0),
  constraint ats_job_post_titles_title_length check (length(title) <= 80),
  constraint ats_job_post_titles_duties_array check (jsonb_typeof(duties) = 'array' and jsonb_array_length(duties) <= 8),
  constraint ats_job_post_titles_needs_array check (jsonb_typeof(needs) = 'array' and jsonb_array_length(needs) <= 8)
);

comment on table public.ats_job_post_titles is
  'Job titles for the recruitment Job Posts page: per-title duties, requirements and key facts. The post templates are looks only and read every word from here.';

create unique index if not exists ats_job_post_titles_title_key
  on public.ats_job_post_titles (lower(btrim(title)));

alter table public.ats_job_post_titles enable row level security;

-- Matches every other ats_ table: application-scoped visibility, service_role only at the database.
drop policy if exists phx_ats_job_post_titles_service_role on public.ats_job_post_titles;
create policy phx_ats_job_post_titles_service_role
  on public.ats_job_post_titles
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.ats_job_post_titles from public, anon, authenticated;
grant select, insert, update, delete on public.ats_job_post_titles to service_role;

-- ---------------------------------------------------------------------------------------------
-- Seed: the three HR roles, in the owner's OWN final wording (pasted in chat 2026-10-06 22:20
-- Cairo; the approved posts are F:\Hiring Posts\2026-10-06 HR Team - Org Structure\). His copy is
-- final — fit the layout to the words, never trim the words. Seeded so the page is usable the
-- minute it deploys. No Medical Representative row: its duties were never his words.
-- ---------------------------------------------------------------------------------------------

insert into public.ats_job_post_titles (title, department, headline, reports_to, duties, needs, menu_name)
values (
  'HR Section Head',
  'Human Resources',
  E'Lead the team behind\nour people.',
  'HR Manager',
  '[
    {"lead": "Lead the HR function", "rest": "— talent acquisition, personnel and office operations"},
    {"lead": "Partner with sales leaders", "rest": "on manpower planning, hiring and people matters"},
    {"lead": "Manage employee relations", "rest": "and ensure fair, consistent policy implementation"},
    {"lead": "Own HR systems", "rest": ", workforce data and management reporting"}
  ]'::jsonb,
  '[
    {"lead": "3–5 years of HR experience", "rest": ", including 2+ years leading a team"},
    {"lead": "Pharmaceutical industry experience", "rest": ", preferably supporting field-force teams"},
    {"lead": "Strong end-to-end recruitment experience", "rest": "across different functions"},
    {"lead": "Strong communication", "rest": ", ownership and people-management skills"},
    {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}
  ]'::jsonb,
  'HR Section Head'
)
on conflict do nothing;

insert into public.ats_job_post_titles (title, department, headline, reports_to, duties, needs, menu_name)
values (
  'Talent Acquisition Specialist',
  'Human Resources',
  null,
  'HR Section Head',
  '[
    {"lead": "Screen and manage candidates daily", "rest": "through WhatsApp, email and our recruitment system"},
    {"lead": "Recruit medical representatives and district managers", "rest": "across Egypt"},
    {"lead": "Coordinate interviews", "rest": "with hiring managers and present qualified shortlists"},
    {"lead": "Manage the candidate journey", "rest": "from initial screening through offer acceptance"},
    {"lead": "Ensure a smooth onboarding handover", "rest": "for every successful candidate"}
  ]'::jsonb,
  '[
    {"lead": "Hands-on recruitment experience", "rest": ", preferably within the pharmaceutical industry"},
    {"lead": "Experience hiring field-force roles", "rest": "is a strong advantage"},
    {"lead": "Strong CV screening and interviewing skills", "rest": ""},
    {"lead": "ATS/recruitment-system experience", "rest": "and strong candidate tracking discipline"},
    {"lead": "Strong Arabic and English", "rest": "communication skills"},
    {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}
  ]'::jsonb,
  'Talent Acquisition'
)
on conflict do nothing;

insert into public.ats_job_post_titles (title, department, headline, reports_to, duties, needs, menu_name)
values (
  'Office Coordinator',
  'Human Resources',
  null,
  'HR Section Head',
  '[
    {"lead": "Coordinate hotel and travel arrangements", "rest": "for field teams and company meetings"},
    {"lead": "Organise meetings, interviews and interview days", "rest": ""},
    {"lead": "Manage day-to-day office operations", "rest": "— supplies, vendors and maintenance"},
    {"lead": "Support HR administration", "rest": "— letters, documentation and employee files"}
  ]'::jsonb,
  '[
    {"lead": "Strong MS Office and Outlook skills", "rest": ""},
    {"lead": "Experience in hotel, travel and meeting coordination", "rest": ""},
    {"lead": "Excellent organisation and follow-up skills", "rest": ""},
    {"lead": "Dependable, detail-oriented and professional", "rest": ""},
    {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}
  ]'::jsonb,
  'Office Coordinator'
)
on conflict do nothing;

commit;
