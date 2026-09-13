-- A compensatory day normally needs an uploaded evidence file. The owner can waive that for a
-- specific day; the waiver is a written note on the row, never a fake attachment path.
alter table public.v2_vacation_requests
  add column if not exists evidence_waiver_note text;

comment on column public.v2_vacation_requests.evidence_waiver_note is
  'Owner-granted exception to the evidence requirement (who, when, why). When set, a compensatory day is complete without an attachment. Never write a placeholder attachment path instead.';

alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_compensatory_required_check;

alter table public.v2_vacation_requests
  add constraint v2_vacation_requests_compensatory_required_check check (
    vacation_type <> 'compensatory'
    or (
      btrim(coalesce(compensatory_event_name, '')) <> ''
      and compensatory_event_date is not null
      and btrim(coalesce(compensatory_event_location, '')) <> ''
      and btrim(coalesce(compensatory_manager_1, '')) <> ''
      and (
        compensatory_attachment_object_path is not null
        or btrim(coalesce(evidence_waiver_note, '')) <> ''
      )
    )
  );
