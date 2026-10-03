-- WHAT: `v2_vacation_request_attachments` — one row per uploaded evidence FILE on a leave request,
--       plus a backfill of every file already recorded in the legacy single-attachment columns on
--       `v2_vacation_requests`, so an existing sick request keeps its document and gains a date.
--
-- WHY:  Owner, 2026-10-03: a sick request must accept SEVERAL photos or PDFs at submit, the employee
--       must be able to upload MORE afterwards — *"that does not replace the one he uploaded before,
--       no, it is an add-on on them"* — and the admin must see WHEN each file arrived ("3 October he
--       uploaded this, by 10 October he uploaded those"). The six
--       `sick_attachment_*` columns hold exactly one file and one `uploaded_at`, so a second upload
--       could only overwrite the first and the arrival date of anything but the last file was lost.
--
--       The legacy columns are KEPT and keep naming the FIRST file. Every existing read path — the
--       evidence-review gate, the approver emails, the report export, the `/attachments/<kind>`
--       download — stays exactly as it is, and the new table is the append-only history beside it.
--       Nothing is dropped and nothing is rewritten.
--
-- ROLLBACK: `drop table if exists public.v2_vacation_request_attachments;`
--           Purely additive: no existing column, row, index or policy is altered, so dropping the
--           table restores the previous state exactly. The backfill copies rows out of
--           `v2_vacation_requests`; the originals are left untouched, so nothing is lost with it.

begin;

-- At most five seconds waiting for any lock: a migration must never hold the leave tables while an
-- employee is filing a request.
set local lock_timeout = '5s';

create table if not exists public.v2_vacation_request_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.v2_vacation_requests (id) on delete cascade,
  -- The evidence kind the file belongs to, matching the legacy column pair it extends.
  kind text not null check (kind in ('sick', 'compensatory')),
  bucket text not null default 'leave-attachments',
  object_path text not null,
  original_name text,
  content_type text,
  size_bytes bigint,
  -- The ONE figure this table exists for: when THIS file arrived, not when the request was filed.
  -- A second upload ten days later carries its own date and never touches the first row's.
  uploaded_at timestamptz not null default now(),
  uploaded_by_hr_id text,
  uploaded_by_login_id text,
  created_at timestamptz not null default now()
);

-- One row per stored object. A retried upload of the same object path can therefore never produce a
-- second line in the admin's list of files.
create unique index if not exists v2_vacation_request_attachments_object_idx
  on public.v2_vacation_request_attachments (object_path);

-- The list read: every file of a request, oldest first, which is the order the admin reads them in.
create index if not exists v2_vacation_request_attachments_request_idx
  on public.v2_vacation_request_attachments (request_id, uploaded_at);

comment on table public.v2_vacation_request_attachments is
  'Append-only evidence files on a leave request, one row per uploaded file with its own upload date. Owner ruling 2026-10-03: a later upload ADDS to the earlier ones and never replaces them. The legacy v2_vacation_requests.sick_attachment_* / compensatory_attachment_* columns still name the FIRST file.';

-- Visibility in this app is application-scoped: every read goes through the service-role client, so
-- RLS here is the belt rather than the braces. Enabled with a service-role-only policy, the shape
-- used by every other table the browser must never reach directly.
alter table public.v2_vacation_request_attachments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
    where polname = 'v2_vacation_request_attachments_service_role'
      and polrelid = 'public.v2_vacation_request_attachments'::regclass
  ) then
    create policy v2_vacation_request_attachments_service_role
      on public.v2_vacation_request_attachments for all to service_role using (true) with check (true);
  end if;
end;
$$;

revoke all on table public.v2_vacation_request_attachments from public, anon, authenticated;
grant all on table public.v2_vacation_request_attachments to service_role;

-- Backfill: every file already recorded in the legacy columns becomes the FIRST row of its request,
-- carrying its own recorded upload date (falling back to when the request was filed, for the few
-- rows written before `*_uploaded_at` was always set). Idempotent through the object-path unique
-- index, so re-running this migration inserts nothing a second time.
insert into public.v2_vacation_request_attachments
  (request_id, kind, bucket, object_path, original_name, content_type, size_bytes, uploaded_at, uploaded_by_hr_id)
select
  r.id,
  'sick',
  coalesce(r.sick_attachment_bucket, 'leave-attachments'),
  r.sick_attachment_object_path,
  r.sick_attachment_original_name,
  r.sick_attachment_content_type,
  r.sick_attachment_size_bytes,
  coalesce(r.sick_attachment_uploaded_at, r.created_at, now()),
  r.employee_hr_id
from public.v2_vacation_requests r
where r.sick_attachment_object_path is not null
on conflict (object_path) do nothing;

insert into public.v2_vacation_request_attachments
  (request_id, kind, bucket, object_path, original_name, content_type, size_bytes, uploaded_at, uploaded_by_hr_id)
select
  r.id,
  'compensatory',
  coalesce(r.compensatory_attachment_bucket, 'leave-attachments'),
  r.compensatory_attachment_object_path,
  r.compensatory_attachment_original_name,
  r.compensatory_attachment_content_type,
  r.compensatory_attachment_size_bytes,
  coalesce(r.compensatory_attachment_uploaded_at, r.created_at, now()),
  r.employee_hr_id
from public.v2_vacation_requests r
where r.compensatory_attachment_object_path is not null
on conflict (object_path) do nothing;

-- Without this the new table is invisible to PostgREST until a restart, and the first read would
-- answer PGRST205 rather than returning rows.
notify pgrst, 'reload schema';

commit;
