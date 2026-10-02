-- phoenix_crm_fingerprint_candidates_need_a_photo
--
-- WHAT THIS CHANGES:
--   One function body: public.phoenix_crm_photos_to_fingerprint(jsonb) now requires
--   `photo_path is not null` on both of its branches. No table, no column, no row changes.
--
-- WHY — THE NIGHTLY PHOTO SWEEP IS ABOUT TO STOP WORKING ALTOGETHER, SILENTLY:
--   The function returns the photos with no fingerprint yet, oldest first, through an anti-join:
--     left join phoenix_crm_photo_fingerprints f on f.photo_path = c.photo_path where f.photo_path is null
--   A NULL photo_path can never match that join, so such a row is a candidate FOREVER. And since the
--   one-tap visit (owner, 2026-09-29) a visit has no photo at all: `photo_path` is nullable on
--   phoenix_crm_visits and NULL for every visit logged that way. `toCandidate` in
--   src/lib/phoenix-crm/server/photo-dupes.ts drops the row without filing anything, so nothing is
--   ever written that would take it out of the list.
--
--   The caller asks for PHOTO_SWEEP_LIMIT = 400 rows a night, ordered by captured_at. Once ~400
--   photo-less visits exist, every night's 400 candidates are all photo-less: the sweep reads
--   nothing, hashes nothing, compares nothing, and REPORTS SUCCESS. No new place photo is ever
--   fingerprinted again, the dead-man's switch stays green, and a re-used photograph is never caught.
--
--   Delta (1) goes live Saturday 3 Oct 2026 with 14 reps — about 170 one-tap visits a day — so the
--   400 fills within three days of real use. Production holds 4 such visits today (all test rows),
--   which is why nothing has gone wrong yet.
--
--   A place cannot be affected: phoenix_crm_places.photo_path is NOT NULL (a place is validated with
--   a live photo). The filter is therefore a no-op on that branch and is written on both anyway, so
--   the predicate does not depend on a constraint a later migration could relax.
--
-- ROLLBACK: re-apply the function body from
--   supabase/migrations/20260927120000_phoenix_crm_photo_fingerprints.sql (identical except for the
--   two `and ... photo_path is not null` lines). Nothing else here can be undone, because nothing
--   else is changed — no rows are read, written or deleted by this migration.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it replaces one function body and touches no data.

begin;
set local lock_timeout = '5s';

-- ── What still needs a fingerprint ──────────────────────────────────────────────────────────────
--
-- OLDEST FIRST, deliberately. A newest-first sweep with a nightly cap can leave an old backlog
-- permanently behind fresher work, and a photo that is never hashed is a photo that can be re-used
-- for ever. Draining from the oldest end means every photo is reached in a fixed number of nights.
--
-- 🔴 AND A CANDIDATE MUST HAVE A PHOTO. Without this the anti-join can never clear a row that has
-- no photo_path, so a one-tap visit occupies a place in the nightly batch for ever — see the header.
--
-- The anti-join lives here rather than in the service because Supabase's client cannot express
-- "rows with no matching row over there" without pulling both sides into memory, which is fine at
-- today's volume and is exactly the kind of thing that stops being fine without anybody noticing.
--
-- A visit's person is the rep; a manager visiting alone has no rep_hr_id, so the person falls back
-- to whoever the visit is attributed to. A place records its creator.
create or replace function public.phoenix_crm_photos_to_fingerprint(p jsonb)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with candidates as (
    select
      'visit'::text as subject_kind,
      v.id as subject_id,
      v.photo_path,
      v.seat_id,
      coalesce(v.rep_hr_id, v.manager_hr_id, v.entered_by_hr_id) as rep_hr_id,
      v.customer_id,
      v.captured_at,
      v.is_test
    from public.phoenix_crm_visits v
    where v.photo_path is not null
      and (coalesce((p ->> 'include_test')::boolean, false) or v.is_test = false)
    union all
    select
      'place'::text,
      pl.id,
      pl.photo_path,
      pl.seat_id,
      pl.created_by_hr_id,
      pl.customer_id,
      pl.captured_at,
      pl.is_test
    from public.phoenix_crm_places pl
    where pl.photo_path is not null
      and (coalesce((p ->> 'include_test')::boolean, false) or pl.is_test = false)
  )
  select coalesce(jsonb_agg(to_jsonb(picked) order by picked.captured_at), '[]'::jsonb)
  from (
    select c.*
    from candidates c
    left join public.phoenix_crm_photo_fingerprints f on f.photo_path = c.photo_path
    where f.photo_path is null
    order by c.captured_at
    limit greatest(1, least(2000, coalesce((p ->> 'limit')::int, 200)))
  ) picked;
$$;

-- Revoking from `public` also strips service_role, which is a member of it, so the grant that
-- follows is mandatory rather than decorative.
revoke execute on function public.phoenix_crm_photos_to_fingerprint(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_photos_to_fingerprint(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
