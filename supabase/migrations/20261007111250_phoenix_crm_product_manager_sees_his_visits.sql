-- phoenix_crm_product_manager_sees_his_visits
--
-- WHAT THIS CHANGES (owner, 2026-10-07: "nada abdullah yesterday submitted double visits with ahmed
-- sharaf those visists are not appearing in his data also check all double visists are appearing to
-- the double visitor"):
--
--   1. phoenix_crm_countable_visits gains `product_manager_hr_id`. The column has existed on the base
--      table since 20261002205436 and the view never carried it, so every report function — all of
--      which read the view and never the raw table — was structurally unable to find the person in it.
--      APPENDED AFTER `customer_validated` on purpose: `create or replace view` accepts a new column
--      only at the END of the list, and two views depend on this one (crm_visits_unified,
--      crm_checkins_unified) so it cannot be dropped and recreated in a tidier order.
--
--   2. phoenix_crm_report_manager_visits gains a THIRD branch — the person in product_manager_hr_id —
--      reported as role_on_visit = 'product_manager', and a new count column, product_manager_visits.
--      Before this it joined manager_hr_id and senior_hr_id only, so a visit the rep filed as the
--      'product_manager' kind appeared in NO row of the one report that says who went out with whom.
--      Measured on production the day this was written: 11 such visits, 8 of them Nada Abdullah's with
--      Ahmed SharafEldeen on 2026-10-06, none of them reachable by him or by anybody else.
--
-- 🔴 NO `double_visits` FIGURE MOVES. The manager branch still joins manager_hr_id and still counts
--   kind = 'double', so every district manager's double-visit count is byte-for-byte what it was. The
--   new branch is a separate person in a separate row with its own column: a product manager is NOT a
--   double visit and is still never filed as one (CLAUDE.md, the 2026-10-02 lock).
--
-- WHY A VIEW AND A FUNCTION AND NOTHING ELSE: the gap was not a missing screen first, it was a column
--   the reports could not see. The TypeScript half — who may open the report about himself — is in
--   src/lib/phoenix-crm/server/reports.ts and src/lib/phoenix-crm/server/access.ts.
--
-- ROLLBACK:
--   Re-run the 20261003174346 view block (the same explicit list without product_manager_hr_id), and
--   the 20260926163000 function block (the two-branch version without product_manager_visits).
--   Nothing has to be rewritten first: this adds a column and a union branch and changes no row.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change reads and writes no data: it widens one view and one read-only function.

begin;
set local lock_timeout = '5s';

-- ── 1. The countable view carries the product manager ────────────────────────────────────────────
-- security_invoker stays: without it the view is a hole straight through the module's
-- service-role-only rule.
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
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does.
    (c.validated_at is not null or c.list_type = 'Pharmacy') as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id
  from public.phoenix_crm_visits v
  join public.phoenix_crm_customers c on c.id = v.customer_id
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list';

comment on view public.phoenix_crm_countable_visits is
  'Visits that count in a KPI, and the second half of that question beside each one. A row is here '
  'when it was on a sent plan, or it is an off-plan visit the manager and the SFE have approved, or '
  'it is an out-of-list visit (which has no approval of its own). `customer_validated` is the other '
  'half: false until the visit''s customer is validated and admitted to the list — except a PHARMACY, '
  'which needs no validation and is always true (owner, 2026-10-03). A KPI counts only the rows '
  'where it is true. The rep''s own "visits saved here, not counting yet" deliberately does not read '
  'it, because it is counting what he saved rather than what counts. The anti-fraud path reads the '
  'raw table and judges everything. `product_manager_hr_id` is the THIRD place a person stands on a '
  'visit, beside manager_hr_id and senior_hr_id — it sits last in the column list only because the '
  'view cannot be recreated, and must be read by name.';

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- ── 2. The report sees every place a person stands on a visit ────────────────────────────────────
-- Three branches, one per column a non-rep can occupy. The grouping already carries role_on_visit, so
-- a person who was both the manager of one visit and the product manager of another gets one row per
-- role and the TypeScript sums them under their own headings.
create or replace function public.phoenix_crm_report_manager_visits(
  p_hr_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with people as (
    select distinct upper(trim(x.hr_id)) as hr_id
    from unnest(p_hr_ids) as x (hr_id)
    where nullif(trim(x.hr_id), '') is not null
  ),
  joined as (
    select pe.hr_id, 'manager'::text as role_on_visit, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits v on v.manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and v.kind in ('double', 'chain')
      and (p_include_test or not v.is_test)
    union all
    select pe.hr_id, 'senior'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits v on v.senior_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    union all
    -- The product manager, in his own column. Both kinds he can be on: 'product_manager' (the rep
    -- ticked one person under "Double visit" and it was him) and 'chain' (he was the second person on
    -- a chain). No `kind` filter is needed — product_manager_hr_id is set on those two kinds alone,
    -- and the constraint phoenix_crm_visits_participants is what guarantees it.
    select pe.hr_id, 'product_manager'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits v on v.product_manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.hr_id, t.visit_date, t.seat_id), '[]'::jsonb)
  from (
    select
      j.hr_id,
      j.role_on_visit,
      j.visit_date,
      j.seat_id,
      j.rep_hr_id,
      (count(*) filter (where j.kind = 'double'))::integer as double_visits,
      (count(*) filter (where j.kind = 'chain'))::integer as chain_visits,
      -- Never added into double_visits: that figure is kind = 'double' on every board and district
      -- managers are judged on it.
      (count(*) filter (where j.kind = 'product_manager'))::integer as product_manager_visits,
      (count(*) filter (where j.list_type = 'AM'))::integer as am_visits,
      (count(*) filter (where j.list_type = 'PM'))::integer as pm_visits
    from joined j
    group by j.hr_id, j.role_on_visit, j.visit_date, j.seat_id, j.rep_hr_id
  ) t;
$function$;

comment on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) is
  'Every visit each named person was on, by the place they stood on it: manager_hr_id (a double or a '
  'chain visit), senior_hr_id (the senior manager of a chain), product_manager_hr_id (the line''s '
  'product manager, on the ''product_manager'' kind or as the second person on a chain). One row per '
  'person, role, day, territory and rep. `double_visits` counts kind = ''double'' and nothing else, '
  'because that figure is what managers are measured on; a product manager''s visits are '
  '`product_manager_visits` and are never folded into it.';

-- 🔴 `revoke EXECUTE`, not `revoke all`, and PUBLIC first: a function in `public` inherits the
-- built-in EXECUTE grant to PUBLIC, and anon/authenticated are members of it — so revoking only
-- those two is a no-op. `tests/migrations-secdef-revoke-guard.test.ts` is the backstop and it asks
-- for this exact shape; the two spellings do the same thing, but only one of them is checkable.
revoke execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) to service_role;

commit;
