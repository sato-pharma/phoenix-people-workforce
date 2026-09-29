-- hiring_document_groups
--
-- WHAT THIS CHANGES: a `document_group` column on public.hiring_document_definitions —
--   'required' | 'onboarding' | 'offboarding' — and the group each of the seventeen existing
--   definitions belongs to, with the display order HR reads them in.
--
-- WHY: the checklist has always been one flat list; HR reads it as three, because the papers a
--   candidate BRINGS, the papers signed ON JOINING and the papers signed ON LEAVING are collected
--   by different people at different times. The Employee Master draws one section band per group
--   (the owner asked for HR's layout exactly, 2026-09-29).
--
--   Distinct from `is_exit_document`, which decides whether a paper is CHASED against an active
--   employee at all. Every offboarding document is an exit document; the grouping is about where a
--   paper is FILED, not about who is chased for it.
--
-- WHAT IT DOES NOT DO: it adds no document, retires none, renames none, and touches no file, tick
--   or note. Nobody's "Hiring Documents Complete" count moves by one. It is the column plus where
--   each existing paper sits, so the code that reads the column can ship safely; the papers HR
--   asked to ADD arrive in a separate migration that is announced before it runs, because that one
--   does change everybody's denominator.
--
-- ORDER MATTERS AGAINST THE DEPLOY: `src/lib/hiring-documents/service.ts` names document_group in
--   its select, and PostgREST answers a missing column by failing the WHOLE read rather than
--   nulling that one field. So this applies BEFORE that build serves traffic, not after.
--
-- ROLLBACK:
--   alter table public.hiring_document_definitions drop column if exists document_group;
--   drop constraint first if it survives the column drop. display_order values are cosmetic and
--   need no rollback. The code must stop naming the column before it is dropped, or every read of
--   the checklist 42703s.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration adds a column and sets it. It deletes nothing and renames nothing.

begin;

alter table public.hiring_document_definitions
  add column if not exists document_group text not null default 'required';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hiring_document_definitions_document_group_check'
  ) then
    alter table public.hiring_document_definitions
      add constraint hiring_document_definitions_document_group_check
      check (document_group in ('required', 'onboarding', 'offboarding'));
  end if;
end $$;

comment on column public.hiring_document_definitions.document_group is
  'Which block of the personnel file this paper belongs to: required (the candidate brings it), onboarding (signed on joining), offboarding (signed on leaving). Drives the section bands on the Employee Master sheet. Not the same question as is_exit_document, which decides whether an ACTIVE employee is chased for it.';

-- The seventeen definitions that exist today, under the names they carry today.
update public.hiring_document_definitions as d
set document_group = v.document_group, display_order = v.display_order
from (values
  ('Personal photos',                     'required',    10),
  ('Graduation certificate',              'required',    20),
  ('Birth certificate',                   'required',    30),
  ('National ID copy',                    'required',    40),
  ('Military status',                     'required',    50),
  ('Criminal record',                     'required',    60),
  ('كعب العمل',                            'required',    70),
  ('Medical check',                       'required',   100),
  ('Signed employment contract',          'onboarding', 110),
  ('Social insurance form',               'onboarding', 120),
  ('Bank account details',                'onboarding', 130),
  ('Signed confidentiality undertaking',  'onboarding', 150),
  ('Signed social insurance Form 6',      'offboarding', 210),
  ('Signed resignation request',          'offboarding', 220),
  ('Signed mutual termination agreement', 'offboarding', 230),
  ('Signed employee clearance',           'offboarding', 240),
  ('Signed company clearance',            'offboarding', 250)
) as v(name, document_group, display_order)
where d.name = v.name;

commit;
