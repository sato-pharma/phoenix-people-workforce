-- Hiring document capture — the file behind the tick.
--
-- WHAT THIS IS FOR. `hiring_document_statuses` has always been a row of tick-boxes: somebody marks
-- "Birth certificate — submitted" and the paper itself goes into a physical folder. So the tracker
-- reports a claim, not evidence, and "which documents are still missing" is only as true as the
-- last person's memory. This table is the evidence: the scan, the photo, or the PDF that was
-- actually handed over, stored privately and linked to exactly one employee × document pair.
--
-- WHY A SEPARATE TABLE AND NOT COLUMNS ON `hiring_document_statuses`. One document is routinely
-- several files — a national ID is two sides, a graduation certificate is a certificate plus a
-- transcript — and the status row is keyed one-per-pair. A child table is the only shape that lets
-- a document carry two pages without inventing file_1/file_2 columns.
--
-- The bucket is PRIVATE and stays private. These are birth certificates, national IDs, criminal
-- records and military-status papers for real employees; nothing here may ever be readable from a
-- public URL. Reads go through /api/hiring-documents/files/[fileId], which resolves the storage
-- path server-side from the row id — the caller never names a storage object, which is the same
-- containment the direct-order and marketing share routes use.

create table if not exists public.hiring_document_files (
  id uuid primary key default gen_random_uuid(),

  -- Text, not a foreign key, for the same reason `hiring_document_statuses.employee_hr_id` is:
  -- HR_IDs are edited by several other paths and a hard FK here would make a rename fail in a
  -- module that only stores paperwork.
  employee_hr_id text not null,
  -- This one IS a foreign key. Deleting a definition must take its files with it, or the storage
  -- objects become unreachable rows nothing lists. (Deletion is soft in the app — `is_active` —
  -- so this fires only on a genuine hard delete.)
  document_id uuid not null references public.hiring_document_definitions (id) on delete cascade,

  storage_bucket text not null default 'hiring-documents',
  -- Unique because two rows pointing at one object would let deleting either one strand or destroy
  -- the other's file. The path carries a random suffix precisely so this can be enforced.
  storage_path text not null unique,

  -- What the file was called when it arrived, shown to HR and used for the download filename. Kept
  -- separately from storage_path, which is sanitized and will not survive Arabic or spaces.
  file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  -- Known only for PDFs this system assembled itself. An uploaded PDF is not parsed to count its
  -- pages — that would be work done to display a number nobody decides anything on.
  page_count integer check (page_count is null or page_count > 0),

  -- 'upload' — a file that arrived as-is (the scanner's own PDF, a photo, a picture of a page).
  -- 'scan'   — pages photographed in Phoenix, polished, and assembled into one PDF by this system.
  -- The distinction matters when reading a document back: a 'scan' has been processed, and anyone
  -- judging whether a stamp looks right should know that before they judge it.
  source text not null default 'upload' check (source in ('upload', 'scan')),

  uploaded_by_hr_id text,
  uploaded_at timestamptz not null default now()
);

comment on table public.hiring_document_files is
  'Scans, photos and PDFs proving a hiring document was actually handed over. Private bucket; read only through the server-side file route.';

-- The dashboard asks "how many files does each employee x document pair have", and the capture
-- screen asks "list this pair's files, newest first". One index serves both.
create index if not exists hiring_document_files_pair_idx
  on public.hiring_document_files (employee_hr_id, document_id, uploaded_at desc);

alter table public.hiring_document_files enable row level security;

-- No policy, on purpose — the same posture as every other admin-only table here. Visibility in this
-- application is application-scoped: reads go through the service-role client behind
-- assertPermission(ctx, 'employee_documents', ...). RLS on with no policy denies anon and
-- authenticated outright and leaves the server in control.
revoke all on public.hiring_document_files from anon, authenticated;

-- ── The bucket ────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'hiring-documents',
      'hiring-documents',
      -- Never public. A birth certificate behind a guessable URL is the whole risk of this feature.
      false,
      -- 15MB. A flatbed scan of an A4 certificate at 300 DPI in colour lands around 3-6MB, and a
      -- multi-page PDF from a document feeder can reach double that; below this and HR would hit
      -- the limit on ordinary paperwork, above it and one bad phone upload fills the bucket.
      15728640,
      -- What a scanner or a phone actually produces. No Office formats: a hiring document is a
      -- picture of a piece of paper, and accepting .docx here would invite a typed transcription
      -- to be filed as though it were the certificate.
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists hiring_documents_service_role on storage.objects';
    execute $policy$
      create policy hiring_documents_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'hiring-documents')
      with check (bucket_id = 'hiring-documents')
    $policy$;
  end if;
end $$;

notify pgrst, 'reload schema';
