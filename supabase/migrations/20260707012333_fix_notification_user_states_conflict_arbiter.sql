begin;

-- notification_user_states_user_unique_idx / _hr_unique_idx were created as PARTIAL
-- unique indexes (`where user_id is not null` / `where hr_id is not null`). Postgres
-- can only use a partial index as an ON CONFLICT arbiter if the INSERT repeats the
-- exact same WHERE predicate, and PostgREST's on_conflict query param has no way to
-- express one. src/lib/notifications/in-app.ts upserts via
-- `.upsert(payload, { onConflict: "notification_event_id,user_id" })` (and the hr_id
-- equivalent) with no predicate, so every such upsert has failed since this table was
-- created with "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" — confirmed live: the table has had zero rows since inception.
--
-- A standard (non-partial) unique btree index already treats every NULL as distinct
-- from every other NULL, so dropping the WHERE predicate is behaviorally identical
-- for constraint enforcement (rows with a NULL user_id/hr_id still never conflict on
-- that index) while making the index usable as a plain ON CONFLICT arbiter.

drop index if exists public.notification_user_states_user_unique_idx;
create unique index notification_user_states_user_unique_idx
  on public.notification_user_states (notification_event_id, user_id);

drop index if exists public.notification_user_states_hr_unique_idx;
create unique index notification_user_states_hr_unique_idx
  on public.notification_user_states (notification_event_id, hr_id);

commit;
