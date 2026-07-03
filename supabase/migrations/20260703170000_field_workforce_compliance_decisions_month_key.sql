-- Field Workforce Compliance decisions: allow month_key-anchored decisions for
-- live (mirror-sourced) months that have no field_workforce_compliance_imports row.
--
-- Scope:
-- - import_id becomes nullable: Excel-archived months keep it; live-mirror-sourced
--   months (no discrete archive/import row) leave it null.
-- - Uniqueness moves from (import_id, recommendation_key) to (month_key, recommendation_key),
--   since month_key is populated for every row regardless of source and is the only
--   anchor common to both Excel-archived and live-mirror-sourced decisions.
-- - No data is dropped or backfilled; existing decisions keep their import_id.

alter table public.field_workforce_compliance_decisions
  alter column import_id drop not null;

drop index if exists public.field_workforce_decisions_import_key_uidx;

create unique index if not exists field_workforce_decisions_month_key_recommendation_uidx
  on public.field_workforce_compliance_decisions (month_key, recommendation_key);

comment on column public.field_workforce_compliance_decisions.import_id is
  'References field_workforce_compliance_imports for Excel-archived months. Null for decisions on live iReports360-mirror-sourced months, which are keyed by month_key + recommendation_key instead.';
