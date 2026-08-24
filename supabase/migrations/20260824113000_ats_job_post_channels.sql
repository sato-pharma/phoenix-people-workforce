-- Recruitment / ATS — where a vacancy was advertised, and which advert produced each CV.
--
-- Context, so nobody "fixes" this back into an automation: Facebook deleted the Groups API from
-- every Graph API version on 2026-04-22 (the `publish_to_groups` permission went with it), and
-- personal accounts have had no publishing API of any kind since 2018. Posting a vacancy into a
-- Facebook group is therefore a human paste, permanently. There is no endpoint to call and no
-- app review that unlocks one.
--
-- What the system CAN own is everything either side of that paste: hold the group list, write the
-- advert once, hand out a DISTINCT apply link per group, and then read back which group each
-- arriving CV actually came from.
--
-- That last question is currently unanswerable. Measured on production 2026-08-24: 426 candidates,
-- every one of them carrying `source` = 'whatsapp' (219) or 'email' (207) and nothing finer. So
-- there is no way to tell which of twenty groups is worth the next post, and no way to stop
-- posting in the seventeen that produce nothing.
--
-- Two objects, both additive:
--   1. ats_job_post_channels                     one row per place a vacancy gets advertised.
--   2. ats_cv_intake_events.source_channel_code  the code the applicant carried in with them,
--                                                stamped at intake from their own first message
--                                                (WhatsApp) or subject line (email).
--
-- Nothing existing is altered or dropped.

begin;

create table if not exists public.ats_job_post_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  url text,
  kind text not null default 'facebook_group',
  is_active boolean not null default true,
  notes text,
  created_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ats_job_post_channels_kind_check
    check (kind in ('facebook_group', 'facebook_page', 'job_board', 'referral', 'other')),
  -- The code is quoted verbatim into a message the APPLICANT sends back to us, so it has to be
  -- short enough to survive a retype and distinctive enough that it can never collide with
  -- ordinary CV prose. The PX- prefix is what makes the extractor safe to run over free text.
  constraint ats_job_post_channels_code_format
    check (code ~ '^PX-[A-Z0-9]{2,10}$')
);

create unique index if not exists ats_job_post_channels_code_key
  on public.ats_job_post_channels (code);

-- Case-insensitive, because "Medical Reps Egypt" and "medical reps egypt" are one group, and a
-- duplicate row would silently split that group's attribution across two counts.
create unique index if not exists ats_job_post_channels_name_key
  on public.ats_job_post_channels (lower(name));

create index if not exists ats_job_post_channels_active_idx
  on public.ats_job_post_channels (is_active, name);

alter table public.ats_job_post_channels enable row level security;

-- Matches every other ats_ table: application-scoped visibility, service_role only at the database.
drop policy if exists phx_ats_job_post_channels_service_role on public.ats_job_post_channels;
create policy phx_ats_job_post_channels_service_role
  on public.ats_job_post_channels
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.ats_job_post_channels to service_role;

-- The advert code that brought this CV in. Nullable forever: every CV that arrived before this
-- migration, and every CV from someone who typed their own message instead of using the link,
-- legitimately has no code. Null means "we do not know", never "no channel".
alter table public.ats_cv_intake_events
  add column if not exists source_channel_code text;

create index if not exists ats_cv_intake_events_source_channel_code_idx
  on public.ats_cv_intake_events (source_channel_code)
  where source_channel_code is not null;

commit;
