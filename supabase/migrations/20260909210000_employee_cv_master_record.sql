-- The employee's CV, filed on the master record.
--
-- WHAT THIS IS FOR. Owner instruction 2026-09-09: when a new employee is added, HR should be able
-- to attach that person's CV to the master record, and the "an employee was added" notice that
-- goes to the SFE Manager should carry a link he can download it from. Until now the only CV in
-- the system belonged to a CANDIDATE (`ats_files`, recruitment), and it stopped existing the
-- moment the candidate became an employee: nothing carried it across, and nobody outside
-- recruitment could reach it.
--
-- WHY COLUMNS ON `employees` AND NOT A CHILD TABLE. An employee has exactly ONE current CV. That
-- is the whole shape of the thing — replacing it is the only edit, and there is no version
-- history anybody has asked to read. This mirrors `photo_path`/`photo_updated_at`, which sit on
-- this same table for the same reason, and it means every surface that already reads an employee
-- row learns whether a CV exists without a second query. A child table would be the right answer
-- the day a CV needs revisions, and moving to one then is a migration, not a redesign.
--
-- THE BUCKET IS PRIVATE AND STAYS PRIVATE. A CV carries a named person's home address, phone
-- number, salary history and previous employers. Nothing here may ever be readable from a
-- guessable URL: reads go through /api/employees/[hrId]/cv, which resolves the storage path
-- server-side from the HR id and never lets a caller name a storage object — the same containment
-- the hiring-documents and marketing-evidence routes use.

alter table public.employees
  -- Object path inside the private `employee-cvs` bucket. Null = no CV on file.
  add column if not exists cv_path text,
  -- What the file was called when it arrived. Kept apart from `cv_path`, which is sanitized to
  -- ASCII and would not survive an Arabic name or a space — this is what the download is named,
  -- and what the notice shows the SFE Manager so he knows what he is about to open.
  add column if not exists cv_file_name text,
  add column if not exists cv_content_type text,
  add column if not exists cv_size_bytes bigint,
  add column if not exists cv_uploaded_at timestamptz,
  add column if not exists cv_uploaded_by_hr_id text,
  -- 'upload'      — a person chose this file off their own disk and attached it.
  -- 'recruitment' — copied from the candidate's own CV when the hire was created from an
  --                 application, so it is the document the candidate actually sent us.
  -- The distinction is not decoration: a recruitment CV is the one recruitment screened against,
  -- and anyone reading a CV to judge a hire should know which of the two they are holding.
  add column if not exists cv_source text;

alter table public.employees
  drop constraint if exists employees_cv_source_check;

alter table public.employees
  add constraint employees_cv_source_check
  check (cv_source is null or cv_source in ('upload', 'recruitment'));

comment on column public.employees.cv_path is
  'Object path inside the private employee-cvs Storage bucket. Null = no CV on file. Read only through /api/employees/[hrId]/cv.';
comment on column public.employees.cv_source is
  'How the CV arrived: upload (somebody attached a file) or recruitment (copied from the candidate record on hire).';

-- Answers "does this person have a CV" for the whole directory in one small scan, which is what
-- the employee list and the new-hire notice both ask. Partial, because the rows without one are
-- the majority and are never the question.
create index if not exists employees_cv_path_idx
  on public.employees (hr_id)
  where cv_path is not null;

-- ── The bucket ────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'employee-cvs',
      'employee-cvs',
      -- Never public. A CV behind a guessable URL is the whole risk of this feature.
      false,
      -- 15MB, the same ceiling as hiring-documents. A PDF CV is well under 1MB; the headroom is
      -- for the scanned-and-photographed ones HR receives from older candidates.
      15728640,
      -- PDF and the two Word formats, because that is what a CV actually arrives as, plus the two
      -- image types for a CV that was photographed rather than typed. Deliberately NOT a wide
      -- list: this bucket holds one kind of document.
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
    execute 'drop policy if exists employee_cvs_service_role on storage.objects';
    execute $policy$
      create policy employee_cvs_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'employee-cvs')
      with check (bucket_id = 'employee-cvs')
    $policy$;
  end if;
end $$;

notify pgrst, 'reload schema';
