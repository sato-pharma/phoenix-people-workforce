-- Add compensatory day support to the clean v2 vacation module.
-- Additive only: does not touch legacy leave objects or payroll data.

begin;
alter table public.v2_vacation_requests
  add column if not exists compensatory_event_name text null,
  add column if not exists compensatory_event_date date null,
  add column if not exists compensatory_event_location text null,
  add column if not exists compensatory_manager_1 text null,
  add column if not exists compensatory_manager_2 text null,
  add column if not exists compensatory_attachment_bucket text null,
  add column if not exists compensatory_attachment_object_path text null,
  add column if not exists compensatory_attachment_original_name text null,
  add column if not exists compensatory_attachment_content_type text null,
  add column if not exists compensatory_attachment_size_bytes bigint null,
  add column if not exists compensatory_attachment_uploaded_at timestamptz null;
alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_vacation_type_check,
  add constraint v2_vacation_requests_vacation_type_check
    check (vacation_type in ('annual', 'emergency', 'sick', 'other', 'compensatory'));
alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_compensatory_required_check,
  add constraint v2_vacation_requests_compensatory_required_check
    check (
      vacation_type <> 'compensatory'
      or (
        btrim(coalesce(compensatory_event_name, '')) <> ''
        and compensatory_event_date is not null
        and btrim(coalesce(compensatory_event_location, '')) <> ''
        and btrim(coalesce(compensatory_manager_1, '')) <> ''
        and btrim(coalesce(compensatory_manager_2, '')) <> ''
        and compensatory_attachment_object_path is not null
      )
    );
create index if not exists v2_vacation_requests_compensatory_event_idx
  on public.v2_vacation_requests (compensatory_event_date, compensatory_event_name)
  where vacation_type = 'compensatory';
notify pgrst, 'reload schema';
commit;
