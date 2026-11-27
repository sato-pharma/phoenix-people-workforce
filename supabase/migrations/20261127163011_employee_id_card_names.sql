-- employee_id_card_names
--
-- WHAT THIS CHANGES: a new table, public.employee_id_card_names, one row per employee: the full name read off the front
--   of the national ID card the joiner uploaded when accepting the offer, in Arabic as printed and as the first, father
--   and last name in English for Libano-Suisse's Additions sheet. Service role only (RLS on, no policy, no browser grant).
-- WHY: owner, 27 Nov 2026 — the additions email went out with Nourhan Abdelmoniem's Father Name blank, because her
--   Phoenix name is two words. "Anyone who accepts the offer uploads the ID card; when they upload it, extract the name."
--   src/lib/employees/id-card-name.ts reads it; the Medical Insurance add list flags anyone without one.
-- ROLLBACK: drop table public.employee_id_card_names;  (only the reads are lost; each can be read again from the card)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing destructive or bulk: a new, empty table.

begin;

create table if not exists public.employee_id_card_names (
  hr_id text primary key references public.employees (hr_id) on update cascade on delete cascade,
  name_ar text not null,
  first_name text not null,
  father_name text not null,
  last_name text not null,
  source_file_id uuid references public.hiring_document_files (id) on delete set null,
  read_by text not null,
  read_at timestamptz not null default now()
);

comment on table public.employee_id_card_names is
  'The name printed on each employee''s national ID card, read from the card they uploaded (Arabic as printed, and first / father / last in English for the insurer''s sheet). Written by src/lib/employees/id-card-name.ts only.';

alter table public.employee_id_card_names enable row level security;
revoke all on table public.employee_id_card_names from public, anon, authenticated;
grant select, insert, update, delete on table public.employee_id_card_names to service_role;

commit;
