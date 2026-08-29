-- Each rep's ASSIGNED contact list, mirrored from the CRM's own web app.
--
-- WHY THIS TABLE HAS TO EXIST. Every other CRM mirror in this repo is built from ACTIVITY: a
-- contact enters ireports360_visits because someone visited it, and ireports360_plan_entries
-- because someone planned it. So a doctor who sits on a rep's list and is never planned and never
-- visited has no row anywhere in Phoenix and is invisible by construction — which is exactly the
-- population "who is this rep supposed to be seeing?" is about. rep-doctor-lists.ts says so in its
-- own header, and could not fix it, because the Reporting API has no contacts endpoint at all
-- (checked three ways on 2026-08-28: the vendor's Postman collection, the API documentation PDF's
-- endpoint list and ER diagram, and the live swagger, which serves exactly 9 paths — none of them
-- contacts).
--
-- WHERE THE DATA COMES FROM. The CRM's WEB app, not the Reporting API — a different host entirely
-- (site10 vs the API's site7). `ContactsList.aspx?t=PM|AM|Pharmacy&q=<agentId>` renders the true
-- list, and the same service account Phoenix already uses for the API can log into it. See
-- src/lib/crm/contacts-web-client.ts for the login handshake and the two traps that page carries.
--
-- MEASURED ON THE FIRST FULL SWEEP, 2026-08-28 (82 current agents, 246 requests, 0 failures):
--   9,521 rows — 6,797 PM, 872 AM, 1,852 Pharmacy — 7,667 distinct doctors.
--   7,219 of those doctors (94.2%) were already known to Phoenix from activity.
--   448 (5.8%) had NEVER been planned or visited by anyone. Those 448 are the reason for this table.
--   Of the doctor rows Phoenix already knew, 99.2% were filed under the same rep, so the vendor's
--   own agent/contact ids join cleanly and nothing here depends on matching names.
--
-- SHAPE. One row per (agent, contact, list type). The composite key is deliberate on all three
-- parts: a contact can legitimately sit on two reps' lists (a shared two-line customer — see the
-- owner's "treasure" rule), and the same contact can appear on one rep's PM and AM lists, which is
-- three rows describing three genuinely different assignments rather than a duplicate.
--
-- THIS IS A SNAPSHOT OF TODAY, NOT A HISTORY. The web page returns only LIVE contacts — the CRM's
-- own `Ended` flag is already applied before Phoenix sees it, and an ended contact simply stops
-- being returned. `first_seen_at` is therefore the only record of when a contact joined a list, and
-- it survives re-sync (the upsert never overwrites it). Nothing downstream may treat absence from
-- this table as "the rep never worked this doctor": measured on the same sweep, 599 contacts (6.8%)
-- that current agents genuinely worked in August 2026 are on nobody's current list.

create table if not exists public.ireports360_contacts (
  -- The vendor's own agent id, identical to ireports360_visits.agent_crm_id.
  agent_crm_id bigint not null,
  -- The vendor's own contact id, identical to ireports360_visits.contact_crm_id. Exact join key.
  contact_crm_id bigint not null,
  -- Which of the agent's three lists this row came from. 'PM' is the doctor list proper and the
  -- one the owner's 90-120 rule describes; 'AM' is a small second doctor list; 'Pharmacy' is not
  -- doctors at all. The vendor spells the third one 'Pharmacy' in the URL, NOT 'PH' — and asking
  -- for an unknown type returns an EMPTY GRID rather than an error, so this check constraint is
  -- the last line of defence against silently mirroring nothing.
  list_type text not null check (list_type in ('PM', 'AM', 'Pharmacy')),
  -- Resolved through the same identity waterfall as a visit, and nullable for the same reason:
  -- the CRM holds agent accounts that no longer map to an employee.
  agent_hr_id text,
  contact_name text,
  -- The vendor keeps an Arabic name beside the Latin one. Filled on 99.9% of doctor rows, and the
  -- only place either spelling exists in Phoenix.
  contact_name_ar text,
  -- Normalized by normalizeContactGrade, exactly like ireports360_visits.crm_contact_grade.
  contact_grade text,
  speciality text,
  -- Filled on only 35.6% of doctor rows measured 2026-08-28, and on 0% for some whole reps. Do NOT
  -- build a page that promises a phone number from this column.
  phone text,
  -- The CRM's OWN address for the contact, which is a different thing from the address on a
  -- check-in row: that one is 81% Phoenix's own reverse-geocode of where the rep stood. This is
  -- the vendor's record of where the doctor IS, and it is filled on 94.8% of doctor rows.
  address text,
  city text,
  zone text,
  crm_region_name text,
  raw_payload jsonb,
  -- Set once, on the row's first sync, and preserved by every later upsert.
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agent_crm_id, contact_crm_id, list_type)
);

create index if not exists ireports360_contacts_agent_idx
  on public.ireports360_contacts (agent_crm_id, list_type);

create index if not exists ireports360_contacts_contact_idx
  on public.ireports360_contacts (contact_crm_id);

create index if not exists ireports360_contacts_agent_hr_idx
  on public.ireports360_contacts (agent_hr_id)
  where agent_hr_id is not null;

alter table public.ireports360_contacts enable row level security;

-- Matches every other ireports360_ table: application-scoped visibility, service_role only at the
-- database. Nothing in the browser reads this directly.
revoke all on table public.ireports360_contacts from anon, authenticated;
grant select, insert, update, delete on table public.ireports360_contacts to service_role;

drop policy if exists ireports360_contacts_service_role on public.ireports360_contacts;
create policy ireports360_contacts_service_role
  on public.ireports360_contacts
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_contacts is
  'Each CRM agent''s assigned contact list (PM / AM / Pharmacy), mirrored from the CRM web app''s '
  'ContactsList.aspx. The only source in Phoenix for a doctor who has never been planned or '
  'visited. Snapshot of the live list, not a history — see first_seen_at.';
