begin;

-- notification_user_states carried TWO independent unique indexes over the same person:
--   notification_user_states_hr_unique_idx   (notification_event_id, hr_id)
--   notification_user_states_user_unique_idx (notification_event_id, user_id)
--
-- src/lib/notifications/in-app.ts upserted against one or the other depending on whether the
-- viewer happened to have a loginId. ON CONFLICT only protects the index it arbitrates on, so
-- any insert that missed the chosen index but collided on the other one raised 23505. Every
-- caller wraps the write in a fail-soft handler, so the error never surfaced in the app — it
-- just meant the write silently never persisted and got retried on the next bell poll, forever.
-- Production logged "duplicate key value violates unique constraint
-- notification_user_states_hr_unique_idx" roughly twice a minute, continuously.
--
-- Two live triggers, both observed on production:
--   1. One hr_id with a divergent user_id — dev-auth writes user_id 'dev.preview' where a real
--      login writes 'A-16'; 8 such rows exist for hr_id 'a-16'. Their events can never be
--      upserted again via the user_id arbiter.
--   2. Concurrent bell reads — the auto-archive fires on every list call, so two overlapping
--      requests both clear the arbiter pre-check, both insert, and the loser dies on the
--      non-arbiter index.
--
-- Fix: hr_id is the canonical employee key in this codebase and is stable per person, so it
-- becomes the single uniqueness key. user_id stays as informational context only. With the
-- user_id unique index gone, a NULL hr_id would silently accumulate duplicate rows instead of
-- upserting, so hr_id is made NOT NULL to fail loudly instead (verified zero NULLs on
-- production and staging before writing this).

do $$
begin
  if to_regclass('public.notification_user_states') is null then
    return;
  end if;

  -- Belt and braces: never flip the column to NOT NULL against unexpected data. If a NULL
  -- somehow exists, leave the column nullable and let the drop below still take effect —
  -- the app-side guard already refuses to write without an hr_id.
  if not exists (select 1 from public.notification_user_states where hr_id is null) then
    alter table public.notification_user_states alter column hr_id set not null;
  end if;

  -- The redundant second arbiter. (notification_event_id, hr_id) alone now enforces one state
  -- row per person per notification; dropping this cannot introduce duplicates.
  drop index if exists public.notification_user_states_user_unique_idx;
end
$$;

commit;
