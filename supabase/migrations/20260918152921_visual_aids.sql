-- visual_aids
--
-- WHAT THIS CHANGES:
--   1. A PRIVATE storage bucket `visual-aids` (PDF, JPEG, PNG; 50 MB per file), readable and
--      writable by service_role only. Nothing is ever served from a public URL.
--   2. A table `public.visual_aids`: one row per uploaded flyer / visual aid — its title, the sales
--      line it belongs to, an optional product name, where the file sits in the bucket, its type,
--      size and page count, and whether it is active or retired (and, when a newer version replaced
--      it, which row replaced it). RLS on, no grant to anon or authenticated: the app reads it with
--      the service-role client after its own permission and line checks.
--
-- WHY:
--   Owner, 2026-09-18: medical reps show the company's promotional flyers to doctors on their
--   company tablets, and those flyers were being sent round on WhatsApp. They now live in Phoenix:
--   the Marketing Manager, the Group Product Manager and the Super Admin upload them against a line,
--   and a rep (and his district, regional and national sales managers) opens only the active ones
--   for his OWN line, full screen, in the employee portal.
--
--   A flyer is never hard-deleted. "Retire" hides it from reps and keeps the row and the file, so the
--   company can always say which material was in front of doctors and when; "Replace" uploads a new
--   version and retires the old one with `superseded_by` pointing at its successor.
--
--   The line list in the CHECK constraint is the three product lines (CNS, Anti Infective, Pedia),
--   spelled exactly as `OFFICIAL_LINE_VALUES` in src/lib/sales/official-lines.ts spells them, minus
--   Head Office, which is not a product line. tests/visual-aids.test.ts pins that this list equals
--   the one the code derives, so a fourth line cannot be added to one and not the other.
--
-- ROLLBACK:
--   drop table public.visual_aids;   -- SAFE only while it holds no rows anyone needs
--   delete from storage.buckets where id = 'visual-aids';   -- after emptying the bucket
--   drop policy visual_aids_service_role on storage.objects;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is additive only: a new bucket, a new table, a new policy. It touches no row.

begin;

-- ── 1. The bucket ────────────────────────────────────────────────────────────────────────────────
-- PRIVATE. A flyer is promotional material for prescription medicines, meant for a doctor in a
-- visit — not for the open internet. Readers get the bytes through a permission-checked route that
-- resolves the storage path from a row id; no caller ever names an object.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'visual-aids',
      'visual-aids',
      false,
      52428800,
      array['application/pdf', 'image/jpeg', 'image/png']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists visual_aids_service_role on storage.objects';
    execute $policy$
      create policy visual_aids_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'visual-aids')
      with check (bucket_id = 'visual-aids')
    $policy$;
  end if;
end $$;

-- ── 2. The library ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.visual_aids (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  line_name text not null,
  product_name text,
  storage_path text not null,
  mime_type text not null,
  file_size_bytes bigint not null,
  page_count integer,
  status text not null default 'active',
  superseded_by uuid references public.visual_aids (id) on delete restrict,
  uploaded_by_hr_id text,
  uploaded_by_login text not null,
  retired_by_hr_id text,
  retired_by_login text,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visual_aids_title_check check (char_length(btrim(title)) between 1 and 160),
  constraint visual_aids_line_check check (line_name = any (array['CNS'::text, 'Anti Infective'::text, 'Pedia'::text])),
  constraint visual_aids_product_check check (product_name is null or char_length(btrim(product_name)) between 1 and 120),
  constraint visual_aids_storage_path_key unique (storage_path),
  constraint visual_aids_mime_check check (mime_type = any (array['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text])),
  constraint visual_aids_size_check check (file_size_bytes > 0 and file_size_bytes <= 52428800),
  constraint visual_aids_page_count_check check (page_count is null or page_count between 1 and 500),
  constraint visual_aids_status_check check (status = any (array['active'::text, 'retired'::text])),
  -- A retired row always says when; an active one never does.
  constraint visual_aids_retired_at_check check ((status = 'retired') = (retired_at is not null)),
  -- Only a retired row can have been replaced, and never by itself.
  constraint visual_aids_superseded_check check (superseded_by is null or (status = 'retired' and superseded_by <> id))
);

comment on table public.visual_aids is
  'Promotional flyers and visual aids reps show doctors on the company tablets. Files in the private visual-aids bucket. Never hard-deleted: retire hides a row from reps.';
comment on column public.visual_aids.line_name is
  'The product line whose reps see it: CNS, Anti Infective or Pedia (the official line spelling).';
comment on column public.visual_aids.superseded_by is
  'Set when a newer version replaced this one; the row is retired at the same moment.';

-- The reader's one query: the active aids of one line, newest first.
create index if not exists visual_aids_active_line_idx
  on public.visual_aids (line_name, created_at desc)
  where status = 'active';

alter table public.visual_aids enable row level security;
revoke all on table public.visual_aids from public, anon, authenticated;
grant all on table public.visual_aids to service_role;

commit;

-- Verify (catalog, not the ledger):
--   select relname, relrowsecurity from pg_class where relname = 'visual_aids';
--   select grantee, privilege_type from information_schema.role_table_grants where table_name = 'visual_aids';
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'visual-aids';
