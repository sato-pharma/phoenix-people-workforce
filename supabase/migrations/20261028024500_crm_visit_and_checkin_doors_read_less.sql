-- The visit and check-in doors read fewer pages: two vendor-visit indexes let the rep reads skip the rows
-- behind their cursor and reach only the agents asked for in the month, the countable-visits view stops
-- probing the off-plan table once per visit, and the check-in door scans the vendor table ONCE instead of
-- twice. NO ROW CHANGES.
--
-- WHY (Stage 2a of the infrastructure roadmap, owner 2026-10-28: "now do the visit and check-in views").
-- The database box has 2 GB and swaps, so what hurts is pages dragged through memory. Read from
-- pg_stat_statements on production (ozucdzovmcqvepbozvqf) on 28 October, pages per call x calls:
--
--   crm_visits_unified, the rep-filtered reader shapes (probe pages a call; the app's own totals since the
--   statistics were last reset, from the same view, beside them):
--     B  rep visits in a window, keyset by id, excluded agents left out      13,789   12.8 M over 1,177 calls
--     C  the same with the agent and double names (the visit lists)          13,879   10.2 M over 1,244 calls
--     C1 C without the keyset (first page)                                   11,205
--     D  agent by CRM id OR by hr id in October, the detail columns          28,233    6.8 M over   977 calls
--     E  rep visits up to a day, keyset by id                                17,900    5.0 M over   240 calls
--   NOT TOUCHED HERE: the double-visit list (any visit with a companion in a window, no rep filter) is
--   the door's heaviest reader by total — 3,424 pages a call over 12,527 calls, 42.9 M — but that average
--   is mostly from before PR 6619 (merged 28 October 02:02 Cairo, now live), which tests a Phoenix
--   visit before its joins: one 7-day run went from 9,807 pages to 3,360. No rep index narrows it further.
--   crm_checkins_unified — about 7.1 million pages, most of it the rep list's check-ins of 50 doctors
--     at a time (src/lib/crm/reps-list.ts, loadCheckins and loadPinsFor), 421 and 472 pages a call.
--
-- WHAT EACH CHANGE BUYS
--
--   1. ireports360_visits (agent_hr_id, visit_date, id) INCLUDE (agent_crm_id, double_hr_id,
--      agent_name, double_name), beside perf_ireports360_visits_agent_hr_id_visit_date_crm
--      (agent_hr_id, visit_date) INCLUDE (agent_crm_id).
--      Shapes B and C read the vendor half of the door through the older index and fetched EVERY row of
--      the window from the heap, then threw away the half behind the keyset. With id in the key, the
--      `id > $last` keyset is checked on the index tuple, so only the rows past the cursor are fetched.
--      🔴 NOT AN INDEX-ONLY SCAN, whatever the INCLUDE list suggests: the door's UNION ALL hands every
--      column of the vendor arm up (the plan reads `Index Scan`, row width 1,223), so the included
--      names never save a page through the door. They were added for an index-only scan the door
--      cannot give; the index is left as built rather than rebuilt on production a second time.
--
--   2. ireports360_visits (agent_crm_id, visit_date), beside ireports360_visits_agent_crm_id_idx
--      (agent_crm_id).
--      Shape D asks for `agent_crm_id = any(...) OR agent_hr_id = any(...)` in one month. With an
--      agent_crm_id index that has no date in it, the planner read the whole month off the visit_date
--      index and filtered by agent; with the date in both indexes, a BitmapOr of the two reaches only
--      the agents' rows in the month.
--
--   🔴 THE TWO OLDER INDEXES STAY — THE OWNER DECLINED DROPPING THEM (28 October 2026). Each one's keys
--   are a prefix of its new neighbour's, so the planner no longer needs them, but they are kept on his
--   word: never add a drop of either to this file or "tidy" them away in a later one without asking him.
--
--   3. phoenix_crm_countable_visits answers "is this off-plan visit approved?" with a hashed IN over
--      the approved off-plan visits instead of a LEFT JOIN probed once per visit. The off-plan table's
--      primary key had taken about 12 million probes (pg_stat_user_indexes, 28 October) because every
--      read of either door walks this view. One hash of the approved rows per read replaces them.
--
--   4. crm_checkins_unified reads ireports360_checkins in ONE scan, the way crm_visits_unified has
--      since 20261024005000: the split at Phoenix CRM's first day becomes an OR inside the scan, and the
--      "Phoenix wins the day" checks probe phoenix_crm_rep_entry_days_cache — its primary key
--      (hr_key, entry_day) and its partial (agent_crm_id, entry_day) index — instead of a MATERIALIZED
--      CTE over phoenix_crm_rep_entry_days(), a function scan the planner can neither index nor
--      estimate. The doctor-chunk read used to walk the (contact_crm_id, check_date) index twice, once
--      per side of the split. The 23 October merge that lost (planning 16.8 -> 39.3 ms) kept that CTE and
--      dropped the bound; this shape was re-measured against it on 28 October about 03:10 Cairo — the
--      export page 112,707 -> 112,806 pages, planning about 12 -> 13 ms, the same 5,000 rows by md5: a
--      wash, not a loss (docs/crm-ordered-door-pages.md, "28 October: the one-scan door").
--
-- MEASURED ON PRODUCTION, 28 October 02:33 (before) and 02:49 to 02:52 Cairo (after) — the same probes
-- before and after, each run once warm, pages from pg_stat_statements (calls = 1), the rows md5-hashed
-- both times:
--
--     shape   before    after    change    rows (md5 before = after)
--     B       13,789    6,236    -55%      1,000  b3c3b0fddc5f26e95b718a1514df50c8
--     C       13,879    6,320    -54%      1,000  bc14ef50ee3007a08f9c4d32adc611e8
--     C1      11,205   11,771     +5%      1,000  b1a5002027a350214419b5e1bf01fe9d
--     D       28,233   24,692    -13%      1,000  78333de8a3fa3fb3f513408feb1fe4d1
--     E       17,900   23,345    +30%      1,000  01644e678836962dda18f79ea08cd3a4
--     check-ins, 50 doctors   795    618    -22%      481  33c33e4769819f02d71c54d3d79594ab
--
--   🔴 E GOT HEAVIER, AND WHY. E is getMappedAgentHrIds (src/lib/crm/reads.ts): every visit a set of
--   reps ever made, paged by id, to learn which of them has any. It has no lower date, so the window
--   is the reps' whole history (45,228 vendor rows, 22,415 past the probe's cursor). Before, the planner
--   read it with a bitmap scan — each heap page once, about 18,000. Now the door's cutover and Phoenix
--   checks (parameters it cannot see at plan time) make it guess 3,744 rows, so it picks a plain index
--   scan on the new index and fetches one heap page per row past the cursor. C1, the first page with no
--   cursor, is the same story in small. Weighed at the calls pg_stat_statements held that morning (B
--   1,177, C 1,244, D 977, E 240), the door reads about 20 million fewer pages for 1.3 million more on E.
--   The cure for E is in its reader (it needs one visit per rep, not every visit), not in this file.
--   Countable visits: 6,952 rows before and after, 0 rows in one and not the other, md5
--   b98f045f405798204a3a84be8334881f both. Check-ins in full: 145,388 rows (138,477 vendor) either way,
--   0 and 0 differences, md5 69955e3ed9576f5b9c1142183d42e9e2 both.
--
-- EXACTNESS — WHY NO ROW CAN MOVE
--
--   Indexes (1, 2): an index changes how a row is found, never which rows a query returns.
--
--   Countable visits (3): phoenix_crm_unplanned_visits.visit_id is the table's PRIMARY KEY, so the old
--   LEFT JOIN matched at most one row per visit (it never multiplied a visit) and `v.id in (...)` reads
--   a list with no NULL in it (it is false, never unknown, for a visit with no approved row). The old
--   `u.status = 'approved'` was true for exactly the visits whose off-plan row is approved, and null
--   otherwise; null and false both fail an OR whose other arms are false, and both pass one whose other
--   arm is true. No column of u was ever selected. So the WHERE keeps the same visits, and the select
--   list is byte-for-byte the 20261023040102 list.
--
--   Check-ins (4): the old door was two UNION ALL runs over the same table, both under the cutover
--   bound, one with `check_date < first_day` and one with `check_date >= first_day AND the two
--   Phoenix-wins checks`. The new door is one scan with `check_date < first_day OR (the two checks)`.
--   The first-day bound is coalesced to infinity, so it is never null; a null check_date is already
--   dropped by the cutover conjunct (`null < x` is not true). So for every row that reaches the choice,
--   `check_date < first_day` is TRUE or FALSE: TRUE rows were the first run and pass the OR; FALSE rows
--   were the second run exactly when both checks pass, and pass the OR exactly then. No row is counted
--   twice (the old runs were disjoint on the same bound; the new door has one run) and none is lost.
--   phoenix_crm_rep_entry_days() is `select hr_key, agent_crm_id, entry_day from
--   phoenix_crm_rep_entry_days_cache` and nothing else — 764 rows either way on 28 October, 0 rows in
--   one and not the other — so the checks ask the same rows the CTE held. Every column, its name, type
--   and order, the contact-name override and the Phoenix branch are the 20261023153000 door unchanged.
--
-- WHO CAN READ THE CACHE. Both doors are security_invoker. crm_checkins_unified is granted to postgres
-- and service_role alone (read back on 28 October), and phoenix_crm_rep_entry_days_cache carries
-- exactly those two grantees; both roles are BYPASSRLS. So reading the cache directly reaches the same
-- rows for the same readers that the SECURITY DEFINER function did — the visit door has done the same
-- since 20261024005000. No browser key can reach either door, before or after.
--
-- HOW EACH INDEX REACHES PRODUCTION. CREATE INDEX CONCURRENTLY, each run on its own before this file
-- (28 October, 02:46 Cairo; both read back valid — 1,870 and 193 pages), so no write lock landed
-- on a table the CRM sync writes all day. CONCURRENTLY cannot run inside a transaction and migrations
-- do, so the statements below are the plain forms guarded by IF NOT EXISTS: no-ops on production, and
-- correct for staging and any rebuilt database.
--
-- ROLLBACK (no data is touched by any of it):
--   drop index concurrently if exists public.ireports360_visits_agent_hr_date_id_idx;
--   drop index concurrently if exists public.ireports360_visits_agent_crm_date_idx;
--   and re-run the phoenix_crm_countable_visits block of 20261023040102 and the crm_checkins_unified
--   block of 20261023153000.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. Nothing here
-- deletes or rewrites a row, and nothing here drops an index.

-- ── 1, 2. The two vendor-visit indexes ──────────────────────────────────────────────────────────────
create index if not exists ireports360_visits_agent_hr_date_id_idx
  on public.ireports360_visits (agent_hr_id, visit_date, id)
  include (agent_crm_id, double_hr_id, agent_name, double_name);

create index if not exists ireports360_visits_agent_crm_date_idx
  on public.ireports360_visits (agent_crm_id, visit_date);

begin;
set local lock_timeout = '5s';

-- ── 3. Countable visits: the off-plan approval is a hashed IN, not a join probed per visit ──────────
create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select
    v.id, v.seat_id, v.line_code, v.customer_id, v.list_type, v.visit_date, v.captured_at, v.kind,
    v.rep_hr_id, v.manager_hr_id, v.senior_hr_id, v.entered_by_hr_id, v.products, v.comment,
    v.photo_path, v.lat, v.lon, v.accuracy_meters, v.place_id, v.distance_meters, v.location_flag,
    v.device_skew_minutes, v.is_test, v.created_at, v.pharmacy_name, v.product_availability,
    v.voice_note_path, v.voice_note_seconds, v.voice_note_bytes, v.is_unplanned, v.next_step,
    v.next_step_on, v.objection, v.objection_note, v.samples_given, v.dwell_seconds,
    v.form_open_seconds, v.capture_source, v.time_anchor_id, v.offline_seconds, v.synced_at,
    v.photo_lat, v.photo_lon, v.photo_accuracy_meters, v.photo_captured_at, v.unplanned_kind,
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does. Coalesced so the
    -- column stays two-state although the join below is a left one.
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id
  from public.phoenix_crm_visits v
  -- LEFT, so the planner drops this join for every reader that never asks for customer_validated
  -- (phoenix_crm_rep_entry_days above all). It can never null-extend: customer_id is NOT NULL and
  -- carries the foreign key. Never "fix" it back to inner — that restores a customer lookup per visit.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      -- 🔴 AN IN, NOT A LEFT JOIN (speed, 2026-10-28). The join probed the off-plan table's primary key
      -- once for EVERY visit any reader walked — about 12 million probes — to read one column. The IN is
      -- one hash of the approved rows per read. Exact: visit_id is that table's primary key, so the list
      -- holds no NULL and at most one row per visit. Never "fix" it back to a join.
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    -- A recorded visit counts once the Administrator approves it (owner, 2026-10-16).
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    );

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- ── 4. Check-ins: ONE scan of the vendor table, the entry day an index probe ────────────────────────
create or replace view public.crm_checkins_unified
  with (security_invoker = true)
as
select
  c.id,
  c.crm_checkin_id,
  c.agent_crm_id,
  c.agent_hr_id,
  c.contact_crm_id,
  coalesce(truth.name, c.contact_name) as contact_name,
  c.lat,
  c.lon,
  c.address,
  c.check_date,
  c.raw_payload,
  c.synced_at,
  c.created_at,
  c.updated_at,
  'ireports360'::text as source,
  c.agent_crm_id as exclusion_crm_id
from (
  -- 🔴 ONE SCAN OF THE VENDOR TABLE, NOT TWO, AND THE ENTRY DAY IS AN INDEX LOOKUP (speed, 2026-10-28) —
  -- the visit door's shape since 20261024005000, on the check-in's wall-clock day. The split below was two
  -- UNION ALL runs over the same table, so the rep list's 50-doctor read walked the (contact_crm_id,
  -- check_date) index twice; and the two checks asked a MATERIALIZED CTE over
  -- phoenix_crm_rep_entry_days(), which a function scan left the planner no way to index. The two arms
  -- stay mutually exclusive on the SAME live bound, so no row is produced twice or lost.
  select x.*
    from public.ireports360_checkins x
   where x.check_date < coalesce(
     (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
     'infinity'::timestamptz
   )
     and (
       -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): the visit door's split, on the check-in's wall-clock
       -- day. A vendor check-in's day is its wall clock as stored (Cairo, labelled UTC — the vendor
       -- convention), so a check-in before that day's midnight "UTC" is on a day before it, where no rep
       -- has an entry day and nothing is asked.
       x.check_date < (
         select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC'
           from public.phoenix_crm_team_starts t
       )
       -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP: the same rule as the visit
       -- door, on the same entry days.
       or (
         -- 🔴 READ FROM THE CACHE TABLE, NOT THROUGH phoenix_crm_rep_entry_days(). The function is that
         -- table and nothing else, and phoenix_crm_rep_entry_days_calc() is still the ONLY body that
         -- COMPUTES an entry day — this reads what that body wrote. The door is security_invoker and is
         -- granted to postgres and service_role alone; the cache carries exactly those two grants and
         -- both roles are BYPASSRLS, so reading it directly reaches the same rows for the same readers
         -- the SECURITY DEFINER function did.
         not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where e.hr_key = lower(btrim(x.agent_hr_id))
              and e.entry_day = (x.check_date at time zone 'UTC')::date
         )
         -- A check-in the sync could not give an hr id is still his, by his CRM id.
         and not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where nullif(btrim(x.agent_hr_id), '') is null
              and e.agent_crm_id = x.agent_crm_id
              and e.entry_day = (x.check_date at time zone 'UTC')::date
         )
       )
     )
) c
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = c.contact_crm_id
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  -- The same expression as the visit door and the plan door, to the character.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
  customer.name,
  p.lat,
  p.lon,
  null::text,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  p.created_at,
  p.created_at,
  p.created_at,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint)
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing (the cache's own key), so a person can never double a check-in.
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
-- Real only, and only a visit whose position was read: a check-in is a time AND a place.
where not p.is_test
  and p.lat is not null
  and p.lon is not null;

revoke all on table public.crm_checkins_unified from anon, authenticated;

commit;

-- READBACK (reads only):
--   select indexrelid::regclass from pg_index where indrelid = 'public.ireports360_visits'::regclass;
--     -> ireports360_visits_agent_hr_date_id_idx and ireports360_visits_agent_crm_date_idx present, beside
--        perf_ireports360_visits_agent_hr_id_visit_date_crm and ireports360_visits_agent_crm_id_idx.
--   select position('phoenix_crm_rep_entry_days()' in pg_get_viewdef('public.crm_checkins_unified'::regclass)) = 0,
--          position('phoenix_crm_unplanned_visits u ' in pg_get_viewdef('public.phoenix_crm_countable_visits'::regclass)) = 0;
--     -> true, true.
