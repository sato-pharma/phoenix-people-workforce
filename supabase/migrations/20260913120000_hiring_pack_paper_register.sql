-- The HR Forms paper register — one row per paper printed, and the row IS the paper's number.
--
-- The owner, 2026-09-13: "make sure every paper and document is auto numbered". Every print from the
-- HR Forms drive — filled from an employee's record or typed in by hand — takes the next number from
-- this table before it reaches the printer, and the number is printed on the page (except on the
-- Authority's own forms, which are never written on: Form 1, Form 6 and the two Ministry of Labour
-- exit templates are numbered here only).
--
-- THE NUMBER IS A DATABASE DEFAULT, never computed in the app. A counter held in a server process or
-- a browser restarts; a sequence does not, and two papers carrying one number would be worse than two
-- carrying none. The shape follows coaching_reports (CR-YYYY-000123): HR-<Cairo year>-<running
-- number>. The running number does NOT reset each year, so a reference is unique on its own and the
-- year is only there to be read.
--
-- PURELY ADDITIVE. Until this is applied the app prints exactly as before, without a number: the
-- store answers "not set up yet" on PGRST205 / 42P01 and the print goes ahead.

begin;

create sequence if not exists public.hiring_pack_paper_register_seq;

create table if not exists public.hiring_pack_paper_register (
  id bigint generated always as identity primary key,
  reference text not null unique default (
    'HR-'
    || to_char(now() at time zone 'Africa/Cairo', 'YYYY')
    || '-'
    || lpad(nextval('public.hiring_pack_paper_register_seq')::text, 6, '0')
  ),
  -- The document key: one of the built-in papers, or custom:<uuid> for an uploaded template.
  document text not null,
  -- The paper's name as it was called when it was printed. Stored rather than derived, because an
  -- uploaded template can be renamed and the register must still say what was handed over.
  document_label text not null,
  -- Whose paper it is. NULL for a paper typed in by hand for somebody with no employee record.
  hr_id text,
  -- The name as printed. For a typed-in paper it is the only record of who it was for.
  subject_name text,
  mode text not null,
  copies integer not null default 1,
  issued_by_hr_id text,
  issued_at timestamptz not null default now(),
  constraint hiring_pack_paper_register_document_not_blank check (btrim(document) <> ''),
  constraint hiring_pack_paper_register_mode check (mode in ('employee', 'manual')),
  constraint hiring_pack_paper_register_copies check (copies between 1 and 20)
);

comment on table public.hiring_pack_paper_register is
  'One row per paper printed from HR Forms; the reference column is the number printed on the paper. Written by the app through the service role only. Never renumber or delete a row: a printed paper carrying that number may already be signed and filed.';

create index if not exists hiring_pack_paper_register_issued_at_idx
  on public.hiring_pack_paper_register (issued_at desc);

create index if not exists hiring_pack_paper_register_document_hr_idx
  on public.hiring_pack_paper_register (document, hr_id, issued_at desc);

-- RLS on with no grants to authenticated or anon, matching the rest of the hiring-pack schema. Every
-- read and write goes through the service-role client behind assertPermission.
alter table public.hiring_pack_paper_register enable row level security;
revoke all on table public.hiring_pack_paper_register from anon, authenticated;
revoke all on sequence public.hiring_pack_paper_register_seq from anon, authenticated;

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Dropping it returns printing to un-numbered papers. It DISCARDS the register of every number
-- already printed, so export it first:
--
--   select reference, document_label, subject_name, mode, copies, issued_by_hr_id, issued_at
--     from public.hiring_pack_paper_register order by id;
--
-- begin;
--   drop table if exists public.hiring_pack_paper_register;
--   drop sequence if exists public.hiring_pack_paper_register_seq;
-- commit;
