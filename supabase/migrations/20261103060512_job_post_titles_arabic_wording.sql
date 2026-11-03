-- job_post_titles_arabic_wording
--
-- The careers page shows every card in both languages, and the Job Posts page's Publish press has to
-- send both. These two columns keep the Arabic a person typed, per job title, so the next post for the
-- same title opens with it. Nullable and never filled by a machine: empty means nobody has typed it yet.
-- Nothing reads them before the Publish press exists, and no existing row changes.

alter table public.ats_job_post_titles
  add column if not exists title_ar text,
  add column if not exists description_ar text;

comment on column public.ats_job_post_titles.title_ar is
  'The job title in Arabic, typed by a person in the Publish dialog. Empty until someone types it.';
comment on column public.ats_job_post_titles.description_ar is
  'The careers card description in Arabic, typed by a person in the Publish dialog. Empty until someone types it.';
