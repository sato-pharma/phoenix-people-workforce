-- ════════════════════════════════════════════════════════════════════════════════════════════════
--  Phoenix CRM — THE INTERVIEWS ON AN INTERVIEWS DAY
--
--  Owner, 2026-10-29: "if interviews attach the cvs and scheduled time". When a day is recorded as
--  Interviews, it carries the interviews themselves, each with the candidate's name, the scheduled time
--  and the CV — two kinds of row:
--    source 'calendar'  the interviews already booked in the hiring calendar for that person and day,
--                       copied at the moment the day is saved (a later edit of the calendar does not
--                       rewrite what the day recorded). The CV is the calendar's own guarded link.
--    source 'added'     one the person adds by hand, with the CV file uploaded here.
--
--  One row per interview, on the same seat, world and day as the day activity it belongs to.
--  Clearing the day, or recording it as something else, deletes that day's rows and their CV files
--  (`src/lib/phoenix-crm/server/interview-cvs.ts`). Nothing here is read by a report function: like
--  the day activity itself it is a RECORD, and it moves no figure (owner, 2026-09-26).
--
--  The CVs live in a private bucket of their own, reached by the service role only. A CV is opened
--  through a ten-minute signed link the app hands out to someone who may read that territory.
--  10 MB per file — the hiring calendar's own CV limit — PDF, Word or a photo of the CV.
--
--  ROLLBACK  drop table if exists public.phoenix_crm_day_interviews;
--            drop policy if exists phoenix_crm_interview_cvs_service_role on storage.objects;
--            (the bucket keeps the CV files; empty it on purpose before deleting it)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_day_interviews (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  is_test boolean not null default false,
  activity_date date not null,
  person_hr_id text,
  source text not null,
  booking_id uuid,
  candidate_name text not null,
  scheduled_at timestamptz not null,
  duration_minutes integer,
  calendar_cv_url text,
  cv_path text,
  cv_file_name text,
  cv_mime_type text,
  created_by_hr_id text not null,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_day_interviews_source check (source in ('calendar', 'added')),
  constraint phoenix_crm_day_interviews_shape check (
    (source = 'added' and booking_id is null and cv_path is not null and cv_file_name is not null and cv_mime_type is not null)
    or (source = 'calendar' and booking_id is not null and cv_path is null)
  ),
  constraint phoenix_crm_day_interviews_cv_path_unique unique (cv_path),
  constraint phoenix_crm_day_interviews_name check (char_length(btrim(candidate_name)) between 1 and 200),
  constraint phoenix_crm_day_interviews_file_name check (cv_file_name is null or char_length(cv_file_name) between 1 and 200),
  constraint phoenix_crm_day_interviews_duration check (duration_minutes is null or duration_minutes between 1 and 1440),
  constraint phoenix_crm_day_interviews_calendar_cv_url check (calendar_cv_url is null or calendar_cv_url like '/api/recruitment/interview-calendar/%')
);

create index if not exists phoenix_crm_day_interviews_day_idx
  on public.phoenix_crm_day_interviews (seat_id, is_test, activity_date);

create unique index if not exists phoenix_crm_day_interviews_booking_unique
  on public.phoenix_crm_day_interviews (seat_id, is_test, activity_date, booking_id)
  where booking_id is not null;

comment on table public.phoenix_crm_day_interviews is
  'The interviews on an Interviews day in Phoenix CRM: the hiring-calendar bookings copied when the day was saved, '
  'and the ones added by hand with their CV. A record only. Written only by the application (service role).';

alter table public.phoenix_crm_day_interviews enable row level security;
drop policy if exists phoenix_crm_day_interviews_service_role on public.phoenix_crm_day_interviews;
create policy phoenix_crm_day_interviews_service_role
  on public.phoenix_crm_day_interviews for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_day_interviews from public, anon, authenticated;
grant all on table public.phoenix_crm_day_interviews to service_role;

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'phoenix-crm-interview-cvs',
      'phoenix-crm-interview-cvs',
      false,
      10485760,
      array[
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
        'image/webp'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists phoenix_crm_interview_cvs_service_role on storage.objects';
    execute $policy$
      create policy phoenix_crm_interview_cvs_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'phoenix-crm-interview-cvs')
      with check (bucket_id = 'phoenix-crm-interview-cvs')
    $policy$;
  end if;
end
$bucket$;

notify pgrst, 'reload schema';

commit;
