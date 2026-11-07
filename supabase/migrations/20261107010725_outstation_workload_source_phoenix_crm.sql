-- outstation_workload_source_phoenix_crm
--
-- WHAT THIS CHANGES: outstation_expense_requests.workload_source also accepts 'phoenix_crm'. The
--   constraint is replaced with the same list plus that one value; no row is touched.
-- WHY: iReports360 was retired on 6 Nov 2026 and Phoenix CRM is the one source of field work. The
--   trip workload the system reads itself (src/lib/outstation/workload-stamp.ts) is stamped
--   'phoenix_crm' from now on, instead of 'ireports360', so the approver's card and the review PDF
--   name the source the figures really came from. Rows already stamped 'ireports360' keep it — the
--   record of what was true on the day — and the morning re-stamp matches both values.
-- ROLLBACK: alter table public.outstation_expense_requests drop constraint outstation_workload_source_check,
--   add constraint outstation_workload_source_check check (workload_source = any (array['manual'::text,
--   'double_visit_import'::text, 'ireports360'::text, 'override'::text]));
--   (only once no row holds 'phoenix_crm' — re-stamp those to 'ireports360' first).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  drop constraint if exists outstation_workload_source_check;

alter table public.outstation_expense_requests
  add constraint outstation_workload_source_check
  check (workload_source = any (array['manual'::text, 'double_visit_import'::text, 'ireports360'::text, 'phoenix_crm'::text, 'override'::text]));

commit;
