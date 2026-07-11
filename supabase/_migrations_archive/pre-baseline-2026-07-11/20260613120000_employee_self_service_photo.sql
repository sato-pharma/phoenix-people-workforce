-- Employee self-service profile photos.
--
-- Adds a place to record each employee's uploaded photo and a private Storage
-- bucket to hold the image bytes. Uploads/reads go through the service-role
-- server only (a same-origin /api/employees/[hrId]/photo route streams the
-- image to authenticated users), so the bucket stays private and no permissive
-- Storage RLS policy is required. Both column adds are additive and nullable —
-- existing rows and the bundled static photos are unaffected.

alter table public.employees
  add column if not exists photo_path text;

alter table public.employees
  add column if not exists photo_updated_at timestamptz;

comment on column public.employees.photo_path is
  'Object path inside the private employee-photos Storage bucket for the employee''s uploaded profile photo. Null = use the bundled static photo / initials.';

-- Private bucket (public = false). 5 MB per-file cap. Service-role writes/reads only.
insert into storage.buckets (id, name, public, file_size_limit)
values ('employee-photos', 'employee-photos', false, 5242880)
on conflict (id) do nothing;
