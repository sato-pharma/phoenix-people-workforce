-- Extend the Sales mapping-audit entity_type CHECK to cover the distributor-profile editors.
--
-- The original CHECK (20260619120000) only allowed the dictionary entity types
-- ('customer_map','product_alias','territory_alias','area_alias','region_alias'). The MONTHLY profile
-- editor (Phase 6 Part A) already writes writeMappingAudit({ entityType: 'distributor_profile' }), but the
-- insert silently failed the CHECK and was swallowed by the best-effort try/catch — so those audits were
-- never recorded. This adds 'distributor_profile' (fixes that latent gap) and 'weekly_distributor_profile'
-- (Phase 6 Part B). Idempotent drop/add. No data change.

-- Defensive: the source_of_sales_mapping_audit table itself is staged-but-maybe-unapplied, so only
-- touch its CHECK when the table actually exists. No-op (not an error) otherwise.
do $$
begin
  if to_regclass('public.source_of_sales_mapping_audit') is not null then
    alter table public.source_of_sales_mapping_audit
      drop constraint if exists source_of_sales_mapping_audit_entity_type_check;
    alter table public.source_of_sales_mapping_audit
      add constraint source_of_sales_mapping_audit_entity_type_check
      check (entity_type in (
        'customer_map',
        'product_alias',
        'territory_alias',
        'area_alias',
        'region_alias',
        'distributor_profile',
        'weekly_distributor_profile'
      ));
  end if;
end $$;
