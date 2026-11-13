-- register_report_it_workflow
--
-- WHAT THIS CHANGES: inserts ONE row into public.workflow_registry_modules, report_it, an exact copy
--   of REPORT_IT_TRANSITIONS (src/lib/report-it/lifecycle.ts): received -> under_assessment -> closed,
--   one step at a time, forward only, no reopen. Nothing else in the registry is touched.
-- WHY: every transition table in code has a registry entry and a Workflow Control map entry
--   (tests/workflow-registry-coverage.test.ts, audit item REC-005). The safety-report lifecycle
--   (REC-033, migration 20261113202407_report_it_lifecycle.sql) is a new table, so it is registered
--   here. Registered for the map ONLY: changeReportStatus (src/lib/report-it/service.ts) never asks
--   the registry. The move is decided by phx_report_it_set_status, a compare-and-set on the status
--   read, and WHO may move a report is decided by identity: a report_it:export role (Super Admin,
--   CEO, Finance Manager) or a person on report_it_dashboard_access. allowedRoles below names the
--   three export roles for the screen; the person grant cannot be written as a role.
-- SAFE TO RE-RUN: `on conflict (module_key) do nothing` - a row that already exists is never
--   overwritten. Before applying, read
--     select module_key, is_active, version from public.workflow_registry_modules where module_key = 'report_it';
--   it should return no rows.
-- ROLLBACK:
--     delete from public.workflow_registry_modules
--      where module_key = 'report_it' and created_by = 'system' and version = 1;
--   Removing the row changes no answer: no code reads it.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one new row in a small configuration table.

begin;

insert into public.workflow_registry_modules (
  module_key,
  module_name,
  description,
  statuses,
  actions,
  is_active,
  created_by,
  updated_by
)
values
  (
    'report_it',
    'Report It (safety reports)',
    'The safety-report lifecycle, an exact copy of REPORT_IT_TRANSITIONS (src/lib/report-it/lifecycle.ts): received, then under assessment, then closed; no reopen. Registered for the map only: phx_report_it_set_status decides the move, and the Report It desk (a report_it:export role or a person on report_it_dashboard_access) is checked by identity in changeReportStatus. Due date: 15 calendar days for a serious case, 90 for any other.',
    '[
      {"key":"received","label":"Received","terminal":false},
      {"key":"under_assessment","label":"Under assessment","terminal":false},
      {"key":"closed","label":"Closed","terminal":true}
    ]'::jsonb,
    '[
      {"key":"start_assessment","label":"Start assessment","from":["received"],"to":"under_assessment","allowedRoles":["Super Admin","CEO","Finance Manager"],"requiresReason":false,"auditLog":"Report It status change","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts","tests/report-it-lifecycle.test.ts"]},
      {"key":"close","label":"Close","from":["under_assessment"],"to":"closed","allowedRoles":["Super Admin","CEO","Finance Manager"],"requiresReason":false,"auditLog":"Report It status change","sideEffects":[],"notifications":[],"tests":["tests/workflow-registry-coverage.test.ts","tests/report-it-lifecycle.test.ts"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  )
on conflict (module_key) do nothing;

commit;
