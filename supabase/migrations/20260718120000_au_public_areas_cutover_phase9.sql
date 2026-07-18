-- =============================================================================
-- PHASE-9 PRODUCTION CUTOVER — public.areas -> the 42 canonical areas
-- =============================================================================
-- GATED. Apply ONLY during the approved go-live window, AFTER the 21 packaged au
-- migrations, and ONLY after a transaction DRY-RUN on production:
--     begin;  \i this_file  -- inspect the RAISE NOTICE + counts;  rollback;
-- then, once the guard passes clean, apply for real with an explicit owner OK.
--
-- SELF-VALIDATING: every id is derived at run time (no hard-coded production ids).
-- The migration RAISES and changes nothing if any live field-area reference has no
-- canonical mapping — the hard stop against a repeat of the 2026-07-07 silent
-- area_id data-loss incident this whole project exists to prevent.
--
-- Prereqs installed by earlier au migrations:
--   * au.canonical_areas seeded with the 42 codes/names        (20260713040000)
--   * au.area_migration_map old_area_id -> canonical_code      (20260713001526)
--   * public.areas.line_id made nullable                       (20260712233618)
--   * all 9 area_id FKs flipped to ON DELETE RESTRICT          (20260712233618)
--
-- REGION/OFFICE ROWS ARE KEPT (deactivated, never deleted). Their occupants were
-- verified on production 2026-07-18 to be exclusively DSM / RSM / NSM / PM / GPM /
-- Head-Office roles (CEO, HR, Marketing, Admin, R&D, Training, SFE, QPPV, …) that
-- legitimately belong to no single 42-area. Their area_id is preserved (zero loss);
-- they simply drop out of the active field-area picker — exactly as on staging.
-- =============================================================================

do $$
declare
  v_missing_canonical int;
  v_unmapped          int;
  v_active            int;
  v_leftover          int;
begin
  ---------------------------------------------------------------------------
  -- 1) Materialise the 42 canonical areas in public.areas (idempotent by code,
  --    line-independent). Canonical codes (AB1, GZ2, …) never collide with the
  --    legacy lowercase slugs (alex_center, cairo, …).
  ---------------------------------------------------------------------------
  insert into public.areas (code, name, is_active, line_id)
  select ca.area_code, ca.area_name, true, null
  from au.canonical_areas ca
  on conflict (code) do update
    set name = excluded.name, is_active = true, line_id = null;

  select count(*) into v_missing_canonical
  from au.canonical_areas ca
  left join public.areas a on a.code = ca.area_code
  where a.id is null;
  if v_missing_canonical <> 0 then
    raise exception 'FIX-E abort: % canonical area(s) failed to materialise in public.areas', v_missing_canonical;
  end if;

  ---------------------------------------------------------------------------
  -- 2) old_area_id -> new canonical public.areas.id (real collapsed field areas
  --    only; region/office rows carry a NULL canonical_code and are excluded).
  ---------------------------------------------------------------------------
  create temporary table _remap on commit drop as
  select amm.old_area_id, a.id as new_area_id
  from au.area_migration_map amm
  join public.areas a on a.code = amm.canonical_code
  where amm.kind = 'area' and amm.canonical_code is not null;

  ---------------------------------------------------------------------------
  -- 3) HARD GUARD. Every area_id referenced by any dependent table must be
  --    resolvable: already canonical, OR a kept region/office, OR in the remap.
  --    Anything else is an unmapped legacy field area -> ABORT with zero writes.
  ---------------------------------------------------------------------------
  with referenced as (
    select area_id from public.employees             where area_id is not null
    union select area_id from public.employee_history     where area_id is not null
    union select area_id from public.coaching_reports     where area_id is not null
    union select area_id from public.job_offers           where area_id is not null
    union select area_id from public.marketing_customers  where area_id is not null
    union select area_id from public.marketing_pharmacies where area_id is not null
    union select area_id from public.marketing_requests   where area_id is not null
    union select area_id from public.position_vacancies   where area_id is not null
    union select area_id from public.positions            where area_id is not null
  )
  select count(*) into v_unmapped
  from referenced r
  where r.area_id not in (select new_area_id from _remap)
    and r.area_id not in (select old_area_id from _remap)
    and r.area_id not in (
      select old_area_id from au.area_migration_map where kind in ('region','office')
    );
  if v_unmapped <> 0 then
    raise exception
      'FIX-E abort: % referenced area_id(s) are neither canonical, mapped, nor a kept region/office. Add them to au.area_migration_map before cutover.',
      v_unmapped;
  end if;

  ---------------------------------------------------------------------------
  -- 4) Remap area_id old -> new across all nine dependent tables. Canonical and
  --    region/office references are left untouched.
  ---------------------------------------------------------------------------
  update public.employees             t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.employee_history      t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.coaching_reports      t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.job_offers            t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.marketing_customers   t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.marketing_pharmacies  t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.marketing_requests    t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.position_vacancies    t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;
  update public.positions             t set area_id = m.new_area_id from _remap m where t.area_id = m.old_area_id;

  ---------------------------------------------------------------------------
  -- 5) Re-sync the denormalized employees.area_name to the canonical name
  --    (owner rule: show names, not codes). Managers on region/office rows keep
  --    their region name; only rows now on a canonical area are updated.
  ---------------------------------------------------------------------------
  update public.employees e
  set area_name = a.name
  from public.areas a
  where e.area_id = a.id
    and a.code in (select area_code from au.canonical_areas)
    and e.area_name is distinct from a.name;

  ---------------------------------------------------------------------------
  -- 6) Retire every non-canonical area (collapsed legacy + regions + offices +
  --    unreferenced orphans): DEACTIVATE, never DELETE, so ON DELETE RESTRICT
  --    never fires and no dependent row is ever orphaned.
  ---------------------------------------------------------------------------
  update public.areas set is_active = false
  where code not in (select area_code from au.canonical_areas)
    and is_active;

  ---------------------------------------------------------------------------
  -- 7) Post-conditions.
  ---------------------------------------------------------------------------
  select count(*) into v_active from public.areas where is_active;
  if v_active <> 42 then
    raise exception 'FIX-E abort: active area count is %, expected exactly 42', v_active;
  end if;

  select count(*) into v_leftover
  from public.employees e
  where e.area_id in (select old_area_id from _remap);
  if v_leftover <> 0 then
    raise exception 'FIX-E abort: % employee row(s) still reference a collapsed legacy area after remap', v_leftover;
  end if;

  raise notice 'FIX-E OK: 42 canonical areas active; field areas remapped; regions/offices retired (kept, occupants preserved).';
end $$;
