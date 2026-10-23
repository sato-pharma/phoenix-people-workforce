-- service_role_statement_timeout_five_minutes
--
-- WHAT THIS CHANGES: the `service_role` database role, the one the app's server uses for nearly every read
--   and write, gets a statement_timeout of 5 minutes. Before this it had none (its rolconfig held only
--   log_temp_files), while `authenticated` has 8s and `anon` 3s. PostgREST applies an impersonated role's
--   own settings to each request it makes as that role, the same way those two limits reach their requests.
--
-- WHY (technical audit, 2026-10-23, P3-01; owner's choice "5 minutes" the same morning): the app gives up
--   on a request after 15 s, but the database kept working on the abandoned query with no limit at all. A
--   pile of them slows every page for everyone — the 22 Oct stall was four database restarts under load.
--   With a limit, stuck or runaway work is dropped instead of piling up.
--
-- WHY FIVE MINUTES, NOT LESS: a function's own `SET statement_timeout` CANNOT extend a lower limit set by
--   its caller — proved on staging 2026-10-23, a function declaring 10s was cancelled at its caller's 1s.
--   The longest limit any function declares is public.phx_sync_sos_run at 300s (twelve more declare 120s),
--   so 300s cuts no job that already states how long it may take. Longest service_role statement measured
--   on production since the 22 Oct 14:25 Cairo stats reset: 13.7 s. Normal days see no difference.
--
-- ROLLBACK: alter role service_role reset statement_timeout; then notify pgrst, 'reload config';

alter role service_role set statement_timeout = '300s';

-- PostgREST reads role settings when it loads its config; tell it to reload so the limit applies now.
notify pgrst, 'reload config';
