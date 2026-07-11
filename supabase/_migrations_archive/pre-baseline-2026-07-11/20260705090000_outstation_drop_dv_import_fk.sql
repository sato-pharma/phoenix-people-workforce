-- Double Visit Analytics rebuild (2026-07-04): the module now reads live off
-- ireports360_visits and no longer maintains double_visit_imports/double_visit_rows. This
-- drops the FK so double_visit_imports can be dropped in a later migration without
-- outstation_expense_requests blocking it. workload_source_import_id itself is KEPT (it is
-- historical/frozen audit data via workload_evidence_snapshot; new evidence writes null here).
-- Confirmed zero live rows reference this FK at authoring time (production check, 2026-07-04).

alter table public.outstation_expense_requests
  drop constraint if exists outstation_expense_requests_workload_source_import_id_fkey;

comment on column public.outstation_expense_requests.workload_source_import_id is
  'Legacy Double Visit import id (table dropped 2026-07). Historical/audit value only — no longer a live foreign key. New expense workload evidence writes null here; see workload_evidence_snapshot for the frozen evidence.';
