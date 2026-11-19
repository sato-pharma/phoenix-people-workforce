-- WHAT: phoenix_crm_place_recommendations gains `writer_role` — who wrote the recommendation:
--       'district_manager' (every row until now, the default) or 'sfe_manager'.
-- WHY:  Owner, 2026-11-19: "in place checks make Khaled Bedair only able to recommend validation or not
--       recommend, never able to take a decision, and the recommended by him goes separately in a separate
--       page for admin decision." The SFE Manager now writes a recommendation where he used to decide, and
--       the Super Admin's new "SFE recommendations" page reads his rows by this column. It also keeps his
--       word off a district manager's board, which names nobody above the manager.
-- ROLLBACK: alter table public.phoenix_crm_place_recommendations drop constraint if exists
--       phoenix_crm_place_recommendations_writer_role_check; drop index if exists
--       public.phoenix_crm_place_recommendations_sfe_idx; alter table public.phoenix_crm_place_recommendations
--       drop column if exists writer_role;  (loses only which rows the SFE Manager wrote)

alter table public.phoenix_crm_place_recommendations
  add column if not exists writer_role text not null default 'district_manager';

alter table public.phoenix_crm_place_recommendations
  drop constraint if exists phoenix_crm_place_recommendations_writer_role_check;

alter table public.phoenix_crm_place_recommendations
  add constraint phoenix_crm_place_recommendations_writer_role_check
  check (writer_role in ('district_manager', 'sfe_manager'));

-- The Super Admin's page reads the SFE Manager's rows alone; a small partial index keeps that one read cheap.
create index if not exists phoenix_crm_place_recommendations_sfe_idx
  on public.phoenix_crm_place_recommendations (updated_at desc)
  where writer_role = 'sfe_manager';
