-- Phase 21: keep hiring-document workflow tables server-owned.
-- The application reads/writes these tables through guarded Next.js API routes
-- using the service role. Direct anon/authenticated Data API grants are not
-- required and should not remain available in production.

alter table public.hiring_document_definitions enable row level security;
alter table public.hiring_document_statuses enable row level security;
alter table public.hiring_document_employee_notes enable row level security;

revoke all on table public.hiring_document_definitions from anon, authenticated;
revoke all on table public.hiring_document_statuses from anon, authenticated;
revoke all on table public.hiring_document_employee_notes from anon, authenticated;

grant select, insert, update, delete on table public.hiring_document_definitions to service_role;
grant select, insert, update, delete on table public.hiring_document_statuses to service_role;
grant select, insert, update, delete on table public.hiring_document_employee_notes to service_role;

drop policy if exists phx_hiring_document_definitions_service_role on public.hiring_document_definitions;
create policy phx_hiring_document_definitions_service_role
  on public.hiring_document_definitions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_hiring_document_statuses_service_role on public.hiring_document_statuses;
create policy phx_hiring_document_statuses_service_role
  on public.hiring_document_statuses
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_hiring_document_employee_notes_service_role on public.hiring_document_employee_notes;
create policy phx_hiring_document_employee_notes_service_role
  on public.hiring_document_employee_notes
  for all
  to service_role
  using (true)
  with check (true);

-- Trigger functions execute through their triggers and do not need direct API
-- execution grants.
revoke execute on function public.phx_autofill_replacement_vacancy_from_employee_insert()
  from public, anon, authenticated;
revoke execute on function public.phx_enforce_terminal_employee_lifecycle_flags()
  from public, anon, authenticated;
revoke execute on function public.phx_release_terminal_manager_ownership_trigger()
  from public, anon, authenticated;
