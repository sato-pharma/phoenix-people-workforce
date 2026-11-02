-- What HR agreed with a joiner before their first day: hiring_joiner_contacts.
--
-- WHAT
--   One row per accepted offer, written from the joiners panel on Hiring Documents: whether HR
--   confirmed the papers with the joiner, the day and time they attend, a note, and who saved it.
--
-- WHY (owner, 2026-11-02: "OPEN IN HER ACCOUNT Contact the joiner, confirm papers and attendance
-- time")
--   No field anywhere recorded this. It is keyed by the OFFER, not the employee, because the contact
--   happens before the joining form or Add Employee has created a record.
--
-- The date and the time carry no zone on purpose: they are what was agreed on the phone, Cairo local,
-- and a zone could only move them.
--
-- Security: service_role only, as every table the app reads through the admin client. The route gates
-- on employee_documents.
--
-- ROLLBACK
--   drop table if exists public.hiring_joiner_contacts;
--   (the panel then says it could not load; the rest of Hiring Documents is untouched)

begin;
set local lock_timeout = '5s';

create table if not exists public.hiring_joiner_contacts (
  offer_id uuid primary key references public.offers(id) on delete cascade,
  papers_confirmed boolean not null default false,
  attendance_date date,
  attendance_time time without time zone,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  updated_by_hr_id text
);

comment on table public.hiring_joiner_contacts is
  'What HR agreed with a joiner before their first day (owner, 2 Nov 2026): papers confirmed, attendance day and time, a note. One row per accepted offer, written from the joiners panel on Hiring Documents.';

alter table public.hiring_joiner_contacts enable row level security;

drop policy if exists phx_hiring_joiner_contacts_service_role on public.hiring_joiner_contacts;
create policy phx_hiring_joiner_contacts_service_role on public.hiring_joiner_contacts
  to service_role using (true) with check (true);

revoke all on table public.hiring_joiner_contacts from public, anon, authenticated;
grant all on table public.hiring_joiner_contacts to service_role;

notify pgrst, 'reload schema';

commit;
