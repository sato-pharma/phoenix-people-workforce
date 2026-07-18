# Phase 8 — `au` migration packaging (repo files)

Packaged 2026-07-13 from staging (`cifwmndunmlxjhyjugxa`), where every object was applied and
verified across Phases 1–7. These files reproduce the `au` 42-area seat model on a fresh database
(i.e. production, in Phase 9). Versions/names match the staging `supabase_migrations` history exactly,
so staging treats them as already-applied and production applies them fresh.

## What's packaged (18 files, `supabase/migrations/`)

**DDL + logic (17)** — mirrored verbatim from the staging migration history:
- `20260712214302_au_area_unification_foundation` — `au` schema + tables (regions, lines,
  canonical_areas, sos_official_line_map, sos_area_crosswalk, seats, line_area_map, occupancy_history),
  FKs `ON DELETE RESTRICT`, one-open-span / current-map unique indexes.
- `..215505 / ..220801 / ..223505` — organogram read views + public wrappers (+ names).
- `20260712233618_au_areas_fk_restrict_and_nullable_line` — flips 10 `public` area_id FKs
  `SET NULL → RESTRICT` (the July-7 incident fix) + makes `public.areas.line_id` nullable.
- `..235901` — `public.au_v_canonical_areas` wrapper.
- `20260713001526_au_area_migration_map` — legacy old-area→canonical mapping table (**staging area ids**;
  see caveat below).
- `..004010` — hardening (revoke anon/auth SELECT on wrappers, indexes, region-consistency trigger).
- `..005901` — seat-continuity lifecycle RPCs (resign/hire/transfer, service-role only).
- `..014207 / ..014444` — Phase 5 monthly-attribution engine + reconcile + public wrappers.
- `..021518 / ..021549` — SEC-1/SEC-2 lockdown (revoke writes + MAINTAIN on `au_v_*` from anon/auth).
- `..022828 / ..023003 / ..023158` — Phase 6 targets table + achievement engine (+ variable_conflict
  fix) + upsert/read RPCs.
- `20260713031640_au_enable_rls_remaining_tables` — Phase 7 deny-all RLS on the remaining `au` tables.

**Reference-data seed (1)** — `20260713040000_au_seed_reference_data`:
- Populates the `au` model (regions 9, lines 3, canonical_areas 42, official-line map 4, crosswalk 42,
  seats 132, line_area_map 126, occupancy 132). The DDL migrations only create empty tables — the data
  was loaded on staging via tooling, so this seed carries it into the repo.
- **Idempotent** (`ON CONFLICT DO NOTHING` throughout), FK-safe order, seats ordered parent-first for
  the self-FK. Occupancy is seeded without the identity `occupancy_id` / generated
  `occupant_canonical_hr_id` (they regenerate) and with `prev_occupancy_id` null (no chains at baseline).

## NOT packaged here — Phase-9 production-cutover work (must be authored against PRODUCTION data)

1. **`public.areas` transition.** On staging this was: insert the 42 canonical codes into
   `public.areas`, remap `area_id` across ~10 modules (employees, positions, vacancies, teams,
   coaching, offers, employee_history, marketing_*), then retire the legacy areas — done via
   `execute_sql`, keyed to **staging's** area ids. It is **NOT** in these migrations and must **NOT**
   be replayed on production. Author a dedicated Phase-9 migration against production's real area ids
   (the `au_area_migration_map` file's ids are staging's and are illustrative only). `ON DELETE
   RESTRICT` (packaged) makes this safe — a still-referenced delete errors instead of nulling.
2. **App-wiring cutover** (code, not migrations): repoint real resignation/offer flows to the `au`
   lifecycle RPCs; repoint portal / employee-360 / incentives to the auto monthly-closing + achievement
   feed; retire the manual Sales Queue from **July 2026** onward (H1 2026 stays on the queue per owner).
3. **Live role-based click-through** on the deployed staging app (organogram / employees / Targets)
   across Super Admin, SFE Manager, NSM, DM, Employee — Phase 8 step 3.

## Verification

- No timestamp collisions with the 10 existing repo migrations (latest existing `20260712030000`);
  all 18 sort after them in chronological order.
- Seed `ON CONFLICT` arbiters validated on staging (idempotent no-ops; row counts unchanged).
- DDL/logic bodies copied verbatim from `supabase_migrations.schema_migrations` on staging.
