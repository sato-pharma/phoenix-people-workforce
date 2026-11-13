-- drop_three_unused_activity_log_indexes
--
-- WHAT THIS CHANGES: drops three indexes on public.activity_events (the page-visit log), 44 MB
-- together: activity_events_module_created_idx (module_key, created_at desc), activity_events_session_idx
-- (session_id, created_at) and activity_events_login_created_idx (login_id, created_at desc).
--
-- WHY (enterprise audit 2026-11-13, REC-040, S03; owner's decision 13 Nov 2026). Production, counters
-- twelve days old (pg_stat_checkpointer.stats_reset, 1 Nov 2026): 0 scans on each of the three, while
-- the table took 63,141 inserts, every one of which wrote all three. The app reads the log only by
-- created_at range and by hr_id with created_at (src/lib/activity/service.ts); no code, script or
-- database function looks it up by module, session or login. The three indexes it does use stay.
--
-- THE REST OF THE UNUSED-INDEX REVIEW, for the record. Of 958 indexes in public and au with 0 scans in
-- those twelve days: 515 enforce a rule (unique, primary key, exclusion, constraint) and 195 lead a
-- foreign key, so they stay; 6 are expression indexes, kept for the planner statistics their
-- expression gives. Of the 242 plain ones, 231 are under 1 MB each (9 MB together) and are not worth
-- the risk of a drop. The other eleven were reviewed one by one; these three go, and eight stay:
--   sos_customer_directory_rollup_distributor_idx (6 MB)  phx_customer_directory, phx_refresh_sos_channel_rollup
--                                                         and phx_sync_sos_reconciliation filter by distributor
--   phoenix_crm_visits_offline_idx, email_delivery_events_recipients_gin_idx,
--   pg_stat_statements_snapshots_query_idx, idx_sos_mapping_audit_entity,
--   ireports360_visits_crm_region_id_idx, geo_locations_address_idx,
--   notification_send_reviews_idempotency_key_idx          1 to 2 MB each; dropping saves next to nothing
--
-- ROLLBACK:
--   create index activity_events_module_created_idx on public.activity_events (module_key, created_at desc);
--   create index activity_events_session_idx on public.activity_events (session_id, created_at);
--   create index activity_events_login_created_idx on public.activity_events (login_id, created_at desc);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

drop index if exists public.activity_events_module_created_idx;
drop index if exists public.activity_events_session_idx;
drop index if exists public.activity_events_login_created_idx;

commit;
