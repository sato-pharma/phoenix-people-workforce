-- Make the second manager name optional for Compensatory Day requests.
-- Event name, event date, event location, first manager, and photo remain required.

begin;
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
        and compensatory_attachment_object_path is not null
      )
    );
notify pgrst, 'reload schema';
commit;
