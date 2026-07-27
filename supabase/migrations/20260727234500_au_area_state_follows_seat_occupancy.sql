-- =============================================================================
-- au.line_area_map.area_state MUST FOLLOW THE SEAT IT DESCRIBES
-- =============================================================================
-- BUG (traced read-only against production ozucdzovmcqvepbozvqf, 2026-07-27):
-- when a rep resigns, au.resign_occupant correctly closes the occupancy span and
-- opens a vacant placeholder on the seat — but NOTHING sets the matching
-- au.line_area_map row back to 'vacant_will_hire'. It stays 'occupied' forever.
--
-- Confirmed by scanning every function in schemas `public` and `au`: only
-- au.f_line_area_map_asof, au.f_monthly_achievement, au.f_monthly_attribution,
-- public.phx_monthly_achievement and public.phx_monthly_attribution reference
-- area_state, and all five READ it. No trigger on au.line_area_map reacts to
-- occupancy (the only one, trg_lam_region -> au.enforce_lam_region, checks region
-- consistency). No TypeScript writes au.line_area_map or au.occupancy_history at
-- all. So area_state was a hand-maintained column that nothing maintained.
--
-- EVIDENCE: all six rep seats vacated in July 2026 kept area_state='occupied'
-- until the owner corrected them by hand on 2026-07-27:
--   anti_infective AB4 (07-06) · anti_infective CA2 (07-07) · pedia D16 (07-11)
--   pedia UE3 (07-17) · cns AB5 (07-17) · cns GZ2 (07-18)
-- Replaying the guard below over au.occupancy_history's seven resignation_rpc
-- events matches exactly those six, and correctly matches nothing for the
-- seventh (SEAT-AIF-NSM, B-157) — see the DM/NSM note in (1).
--
-- ---------------------------------------------------------------------------
-- NO PAYOUT / TARGET / OTHERS-ROUTING IMPACT — please read before reviewing.
-- ---------------------------------------------------------------------------
-- au.line_area_map.carries_target is
--     generated always as (area_state in ('occupied','vacant_will_hire')) stored
-- so BOTH sides of the only transition this migration performs yield
-- carries_target = true. Nothing that keys off carries_target can change:
--   * src/lib/sales/monthly-targets.ts loadTargetableAreas -> .eq("carries_target", true)
--   * src/lib/sales/territory/skeleton.ts loadLineAreas   -> .eq("carries_target", true)
-- Nor can attribution move: au.f_monthly_attribution and au.f_monthly_achievement
-- SELECT and GROUP BY area_state, but never filter or weight on it — it is a label
-- column on the output grid, not an input to any sum. And the Others rows
-- ('other_permanent' / 'other_line_specific') are excluded twice over, see (1).
-- Net user-visible effect: the "vacant" badge in the Monthly Targets workspace
-- (src/components/sales/targets-workspace.tsx) starts telling the truth, and the
-- area_state column on the attribution/achievement grids stops lying. No money moves.
--
-- Note also that au.v_org_tree and au.v_org_structure_kpis derive vacancy from
-- au.occupancy_history, NOT from area_state — the organogram and headcount KPIs
-- were already correct throughout. This fixes the sales-side territory view.
--
-- Regression guard: tests/au-seat-occupant-resolver.test.ts (static) and
-- `pnpm run db:au:reconcile-area-state` (live, read-only).
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) One guarded helper, called by both lifecycle RPCs.
-- ---------------------------------------------------------------------------
-- Deliberately ONE function rather than the same UPDATE pasted into resign and
-- hire: the six-copy occupancy predicate that PR #1395 had to consolidate is the
-- cautionary tale. Four guards, each load-bearing:
--
--   a) m.effective_to is null    — au.line_area_map is period-versioned; only the
--      row in force may move. A superseded mapping is history and stays frozen.
--
--   b) m.rep_seat_id = p_seat_id — the exact FK the readers dereference
--      (au.f_monthly_attribution resolves lam.rep_seat_id -> occupant), so the flag
--      can never disagree with the seat it is supposed to describe. Verified on
--      production: for all 105 open rows carrying a rep seat, that seat's own
--      (line_code, area_code) equals the row's, and its tier is REP — so this is
--      equivalent to matching on the seat's line_code + area_code today, while
--      staying correct if an area is ever re-mapped to a different rep seat (the
--      exact scenario au.f_line_area_map_asof was built for). It also makes the
--      Others exclusion STRUCTURAL: all 41 'other_permanent' /
--      'other_line_specific' rows have rep_seat_id IS NULL, so they cannot match.
--
--   c) m.area_state = p_from_state — belt and braces on top of (b). Even if an
--      Others row were ever given a rep seat, its state is 'other_permanent' or
--      'other_line_specific', so it matches no transition defined here. Those
--      areas are never hired into and must keep the state they have. This also
--      makes both calls self-healing rather than destructive: a row already in
--      the target state simply matches nothing.
--
--   d) seat_tier = 'REP' — a DM/RSM/NSM/CEO resignation must NOT vacate areas.
--      area_state describes whether the AREA has a rep working it, not whether
--      its manager's box is filled; a departing DM leaves ~5 areas still staffed,
--      and their vacancy is represented by the DM seat itself (au.v_org_tree /
--      au.v_org_structure_kpis already read that correctly). On production this
--      guard is belt-and-braces too — only REP seats carry a non-null area_code —
--      but it states the intent where a future seat model might not.
--
-- Returns the row count so callers/tests can assert; resignations must never fail
-- because of a map inconsistency, so a 0-row match is a silent no-op here and a
-- loud one in au.f_line_area_occupancy_drift() below.
create or replace function au.sync_area_state_for_seat(
  p_seat_id text,
  p_from_state text,
  p_to_state text
)
returns integer
language plpgsql
security definer
set search_path to 'au', 'public'
as $$
declare
  v_rows integer;
begin
  update au.line_area_map m
     set area_state = p_to_state
   where m.effective_to is null
     and m.rep_seat_id = p_seat_id
     and m.area_state = p_from_state
     and exists (
       select 1 from au.seats s
       where s.seat_id = p_seat_id and s.seat_tier = 'REP'
     );
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

comment on function au.sync_area_state_for_seat(text, text, text) is
  'Moves the OPEN au.line_area_map row whose rep_seat_id = p_seat_id from p_from_state to p_to_state, for REP seats only. Never touches other_permanent / other_line_specific (those rows have no rep seat, and their state matches no transition). Returns rows affected; 0 is a legitimate no-op.';

revoke all on function au.sync_area_state_for_seat(text, text, text) from public, anon, authenticated;
grant execute on function au.sync_area_state_for_seat(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Resignation: the area goes back on the hiring list.
-- ---------------------------------------------------------------------------
-- Body is 20260713005901_au_lifecycle_seat_continuity_rpcs.sql verbatim plus the
-- final `perform`. Same transaction, so the seat and its area can never disagree:
-- public.phx_resign_employee_and_open_vacancy already wraps the whole resignation.
create or replace function au.resign_occupant(
  p_seat_id text, p_effective_date date, p_reason text default null, p_actor text default null)
returns bigint language plpgsql security definer set search_path = au, public as $$
declare v_cur au.occupancy_history; v_seat au.seats; v_mgr text; v_new bigint;
begin
  select * into v_seat from au.seats where seat_id = p_seat_id;
  if not found then raise exception 'resign: seat % not found', p_seat_id; end if;
  select * into v_cur from au.occupancy_history where seat_id = p_seat_id and effective_to is null;
  if not found then raise exception 'resign: seat % has no open span', p_seat_id; end if;
  if v_cur.occupant_hr_id is null then raise exception 'resign: seat % is already vacant', p_seat_id; end if;
  update au.occupancy_history set effective_to = p_effective_date where occupancy_id = v_cur.occupancy_id;
  select occupant_hr_id into v_mgr from au.occupancy_history where seat_id = v_seat.parent_seat_id and effective_to is null;
  insert into au.occupancy_history(seat_id,occupant_hr_id,node_type,effective_from,event_type,line_code,region_code,area_code,manager_seat_id,manager_hr_id,prev_occupancy_id,change_reason,source_system,changed_by_hr_id)
  values (p_seat_id,null,'vacant_placeholder',p_effective_date,'resign',v_seat.line_code,v_seat.region_code,v_seat.area_code,v_seat.parent_seat_id,v_mgr,v_cur.occupancy_id,p_reason,'resignation_rpc',p_actor)
  returning occupancy_id into v_new;
  -- The seat is now vacant; the area it serves must say so too.
  perform au.sync_area_state_for_seat(p_seat_id, 'occupied', 'vacant_will_hire');
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Hiring: the mirror, or the bug simply inverts.
-- ---------------------------------------------------------------------------
-- Verified: au.hire_into_seat did NOT restore area_state, so once (2) starts
-- writing 'vacant_will_hire', filling the seat would have left the area reading
-- vacant forever — the same defect pointing the other way.
--
-- HONEST SCOPE NOTE: au.hire_into_seat has essentially never run. As of 2026-07-27
-- au.occupancy_history holds 132 seed_baseline rows, 7 resignation_rpc rows, and
-- exactly ONE hire_rpc row — occupancy_id 143, created by hand that day
--   au.hire_into_seat('SEAT-PED-DM-CA','PD-0006', date '2026-07-19', 'claude-code-manual-correction')
-- to seat the Pedia Cairo DSM. It still has NO TypeScript caller: the only au RPC the
-- app invokes is au.resign_occupant, via public.phx_resign_employee_and_open_vacancy
-- from src/lib/resignations/service.ts. So new hires do not land on au seats unless
-- someone runs the RPC manually. This half is therefore a latch on a hand-driven
-- path, not a repair of observed damage — but it has to land in the same migration
-- as (2) regardless: shipping the vacate side alone would guarantee the inverted bug
-- the first time anyone does use it. The unwired hire path is the larger half of the
-- overall defect and is tracked in docs/area-unification/vacancy-models.md.
--
-- (occupancy_id 143 is a DM seat, so it correctly did NOT move any area_state —
-- area_state describes REP staffing. It is the fixture the hire-path guard uses.)
create or replace function au.hire_into_seat(
  p_seat_id text, p_hr_id text, p_effective_date date, p_actor text default null)
returns bigint language plpgsql security definer set search_path = au, public as $$
declare v_cur au.occupancy_history; v_seat au.seats; v_mgr text; v_new bigint;
begin
  select * into v_seat from au.seats where seat_id = p_seat_id;
  if not found then raise exception 'hire: seat % not found', p_seat_id; end if;
  select * into v_cur from au.occupancy_history where seat_id = p_seat_id and effective_to is null;
  if found then
    if v_cur.occupant_hr_id is not null then raise exception 'hire: seat % already occupied by %', p_seat_id, v_cur.occupant_hr_id; end if;
    update au.occupancy_history set effective_to = p_effective_date where occupancy_id = v_cur.occupancy_id;
  end if;
  select occupant_hr_id into v_mgr from au.occupancy_history where seat_id = v_seat.parent_seat_id and effective_to is null;
  insert into au.occupancy_history(seat_id,occupant_hr_id,node_type,effective_from,event_type,line_code,region_code,area_code,manager_seat_id,manager_hr_id,prev_occupancy_id,change_reason,source_system,changed_by_hr_id)
  values (p_seat_id,p_hr_id,'person',p_effective_date,'hire',v_seat.line_code,v_seat.region_code,v_seat.area_code,v_seat.parent_seat_id,v_mgr,v_cur.occupancy_id,null,'hire_rpc',p_actor)
  returning occupancy_id into v_new;
  -- The seat is filled; the area is staffed again.
  perform au.sync_area_state_for_seat(p_seat_id, 'vacant_will_hire', 'occupied');
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Transfers are already correct by composition — no body change.
-- ---------------------------------------------------------------------------
-- au.transfer_occupant calls resign_occupant(from) then hire_into_seat(to), so
-- with (2) and (3) in place the from-area flips to 'vacant_will_hire' and the
-- to-area to 'occupied' in one transaction. Recording that as a comment so the
-- next reader does not have to re-derive it — and so the guard in
-- tests/au-seat-occupant-resolver.test.ts has something to assert against.
comment on function au.transfer_occupant(text, text, text, date, text, text) is
  'Moves an occupant between seats. Inherits area_state maintenance from au.resign_occupant (from-seat -> vacant_will_hire) and au.hire_into_seat (to-seat -> occupied); do not add a third copy of that UPDATE here.';

-- ---------------------------------------------------------------------------
-- 5) au.seats.seat_label: the SAME defect class, one column over.
-- ---------------------------------------------------------------------------
-- seat_label baked occupancy into a static string at seed time — e.g.
-- 'PEDIA Cairo DM (VACANT)'. Nothing maintains it, so it goes stale the moment a
-- seat is filled or vacated, exactly like area_state did. Two seats carried the
-- suffix on 2026-07-27: SEAT-AIF-DM-GZ (genuinely vacant, label happened to be
-- right) and SEAT-PED-DM-CA (occupied by PD-0006 since the manual hire above, so
-- the label was WRONG).
--
-- The fix is to stop storing the state, not to maintain a third copy of it:
--   (a) strip the occupancy token from the stored label — a label is a NAME;
--   (b) derive the suffix at read time in au.v_org_tree from live occupancy.
-- Adding the suffix to resign_occupant/hire_into_seat was the alternative, and is
-- rejected on purpose: hard-coding state into a text column is what created this
-- bug, and a derived value cannot go stale.
--
-- The strip is anchored and case-insensitive so it can only ever remove a trailing
-- '(vacant)' / '(occupied)'. Dry-run read-only against production over all 132
-- labels: exactly these two change, and every legitimately parenthesised label is
-- untouched — 'ANTI_INFECTIVE Delta (1) DM', 'PEDIA RSM (Alex-BHR, Delta (1),
-- Delta (2))', 'CNS Others (pseudo-DM, sales only, no target)', and the acting-DM
-- label. Idempotent: re-running matches nothing.
--
-- Ordering note: the seed (20260713040000) writes those labels and runs first, so
-- a fresh-database chain seeds them and this migration cleans them up. No CHECK
-- constraint is added for that reason — it would break the seed on a rebuild.
update au.seats
   set seat_label = regexp_replace(seat_label, '\s*\((?:vacant|occupied)\)\s*$', '', 'i')
 where seat_label ~* '\((?:vacant|occupied)\)\s*$';

comment on column au.seats.seat_label is
  'Human-readable seat NAME. Must not encode occupancy — it is static and would go stale. Use au.v_org_tree.seat_display_label, which derives the (VACANT) suffix from the current occupancy span.';

-- Same body as 20260712223505_au_org_tree_add_names.sql plus one appended column.
-- `create or replace view` may only add columns at the END, which is what this does,
-- so the existing ACL (postgres + service_role; anon/authenticated revoked by
-- 20260713004010) is preserved rather than reset. The revoke below re-asserts that
-- end state explicitly so the view can never be widened by accident.
create or replace view au.v_org_tree as
with recursive tree as (
  select s.seat_id, s.parent_seat_id, s.seat_tier, s.line_code, s.region_code, s.area_code,
         s.is_other_pseudo_dm, s.seat_label, 0 as depth, array[s.seat_id] as path
  from au.seats s where s.parent_seat_id is null
  union all
  select c.seat_id, c.parent_seat_id, c.seat_tier, c.line_code, c.region_code, c.area_code,
         c.is_other_pseudo_dm, c.seat_label, t.depth + 1, t.path || c.seat_id
  from au.seats c join tree t on c.parent_seat_id = t.seat_id
)
select t.seat_id, t.parent_seat_id, t.seat_tier, t.line_code, t.region_code, t.area_code,
       t.is_other_pseudo_dm, t.seat_label, t.depth, t.path,
       o.occupant_hr_id, o.node_type, (o.occupant_hr_id is null) as is_vacant,
       ca.area_name, rg.region_name, ln.line_name, ln.line_id,
       -- Derived, never stored: the label plus the state as it actually is right now.
       case when o.occupant_hr_id is null then t.seat_label || ' (VACANT)' else t.seat_label end
         as seat_display_label
from tree t
left join au.occupancy_history o on o.seat_id = t.seat_id and o.effective_to is null
left join au.canonical_areas ca on ca.area_code = t.area_code
left join au.regions rg on rg.region_code = t.region_code
left join au.lines ln on ln.line_code = t.line_code;

-- `select *` is expanded at create time, so the wrapper must be replaced too or it
-- will not expose the new column.
create or replace view public.au_v_org_tree as select * from au.v_org_tree;
revoke all on public.au_v_org_tree from anon, authenticated, public;
grant select on public.au_v_org_tree to service_role;

-- ---------------------------------------------------------------------------
-- 6) The reconciliation query this bug went unnoticed for lack of.
-- ---------------------------------------------------------------------------
-- Reports every open au.line_area_map row whose area_state disagrees with the
-- current occupancy of its rep seat, plus the three shapes that would let such a
-- disagreement HIDE (a staffable row with no rep seat to compare against, an
-- Others row that acquired one, a rep seat absent from the map entirely).
-- Empty result = reconciled. Production is empty as of 2026-07-27, after the
-- owner's one-off correction of the six areas listed at the top.
create or replace function au.f_line_area_occupancy_drift()
returns table (
  drift_kind text,
  line_code text,
  area_code text,
  area_state text,
  rep_seat_id text,
  occupant_hr_id text,
  detail text
)
language sql
stable
security definer
set search_path to 'au', 'public'
as $$
  -- 1. The reported bug: area says staffed, seat is empty.
  select 'occupied_but_seat_vacant', m.line_code, m.area_code, m.area_state, m.rep_seat_id,
         null::text,
         'rep seat has no current occupant (vacated without the area being released)'
  from au.line_area_map m
  where m.effective_to is null
    and m.area_state = 'occupied'
    and m.rep_seat_id is not null
    and not exists (
      select 1 from au.occupancy_history o
      where o.seat_id = m.rep_seat_id and o.effective_to is null and o.occupant_hr_id is not null
    )

  union all
  -- 2. The inverse: area says vacant, someone is sitting in the seat.
  select 'vacant_but_seat_occupied', m.line_code, m.area_code, m.area_state, m.rep_seat_id,
         o.occupant_hr_id,
         'rep seat is occupied (hired without the area being marked staffed)'
  from au.line_area_map m
  join au.occupancy_history o
    on o.seat_id = m.rep_seat_id and o.effective_to is null and o.occupant_hr_id is not null
  where m.effective_to is null
    and m.area_state = 'vacant_will_hire'

  union all
  -- 3. Staffable row with nothing to reconcile against — reads clean while being
  --    unmaintainable, because au.sync_area_state_for_seat keys on rep_seat_id.
  select 'staffable_row_without_rep_seat', m.line_code, m.area_code, m.area_state, null::text,
         null::text,
         'area_state is occupied/vacant_will_hire but rep_seat_id is null'
  from au.line_area_map m
  where m.effective_to is null
    and m.area_state in ('occupied', 'vacant_will_hire')
    and m.rep_seat_id is null

  union all
  -- 4. Others rows are never hired into; one holding a rep seat is a modelling error.
  select 'other_row_with_rep_seat', m.line_code, m.area_code, m.area_state, m.rep_seat_id,
         null::text,
         'other_permanent/other_line_specific row carries a rep seat'
  from au.line_area_map m
  where m.effective_to is null
    and m.area_state in ('other_permanent', 'other_line_specific')
    and m.rep_seat_id is not null

  union all
  -- 5. A rep seat no open map row points at — its occupancy is tracked nowhere.
  select 'rep_seat_absent_from_map', s.line_code, s.area_code, null::text, s.seat_id,
         o.occupant_hr_id,
         'REP seat has no open line_area_map row referencing it'
  from au.seats s
  left join au.occupancy_history o
    on o.seat_id = s.seat_id and o.effective_to is null
  where s.seat_tier = 'REP'
    and not exists (
      select 1 from au.line_area_map m
      where m.effective_to is null and m.rep_seat_id = s.seat_id
    )

  union all
  -- 6. A seat_label that asserts occupancy — the same stale-string defect as
  --    area_state, one column over. Any tier, since seat_label is not REP-only.
  --    Reported whether or not the assertion currently happens to be true: a label
  --    that says '(VACANT)' is stale by construction, because nothing maintains it.
  select 'seat_label_asserts_occupancy', s.line_code, s.area_code, null::text, s.seat_id,
         o.occupant_hr_id,
         'seat_label hard-codes an occupancy state (' || s.seat_label ||
           ') — occupancy belongs in au.v_org_tree.seat_display_label, which is derived'
  from au.seats s
  left join au.occupancy_history o
    on o.seat_id = s.seat_id and o.effective_to is null
  where s.seat_label ~* '\((?:vacant|occupied)\)\s*$';
$$;

comment on function au.f_line_area_occupancy_drift() is
  'Reconciles au.line_area_map.area_state against au.occupancy_history. Empty = consistent. Non-empty means a vacated area still reads as staffed (or the reverse) somewhere in the sales territory views.';

revoke all on function au.f_line_area_occupancy_drift() from public, anon, authenticated;
grant execute on function au.f_line_area_occupancy_drift() to service_role;

-- The `au` schema is not exposed on PostgREST, so the reconciliation script reads
-- through a public wrapper, exactly as every other au_v_* surface does. Both
-- revokes are required: the public schema's default ACL auto-grants to
-- `authenticated`, and `revoke ... from public` alone does not strip that.
create or replace view public.au_v_line_area_occupancy_drift as
  select * from au.f_line_area_occupancy_drift();

revoke all on public.au_v_line_area_occupancy_drift from anon, authenticated, public;
grant select on public.au_v_line_area_occupancy_drift to service_role;

notify pgrst, 'reload schema';

commit;
