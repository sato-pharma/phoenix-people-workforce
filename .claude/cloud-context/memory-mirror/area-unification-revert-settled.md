---
name: area-unification-revert-settled
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: The org-chart PAGE uses the AU seat model (au_v_org_tree) ... suppressFilledVacancyRows only affects the Vacancies report + CEO seat count (see `organogram-has-two-data-paths-suppress-only-hits-vacancies`). Older text follows: The 2026-07-02 area/region/line 'unification' (line_area_region_map / line_zones / line_zone_regions + employees.region_code) was FULLY REVERTED at the owner's request and employees.region_code was DROPPED — do not resurrect either. Sales scope resolves via employees.region_name (NOT region_code) → regionCodesForNames, and fails CLOSED to empty on any region_name/line-name drift. Durable facts it surfaced: the organogram renders only from position_vacancies, a 'team' spans many areas by design, and Head-Office confidentiality rests on a hardcoded line keyset now backed by a write-time allow-list."
metadata:
  node_type: memory
  type: project
  originSessionId: 9103a28a-2cb3-4ee2-a65e-bff753683245
  modified: 2026-09-26T00:35:25.846Z
---

## Settled: the unification is reverted — do not resurrect it

The 2026-07-02 unification (repointed `lines.code`/`areas.code`, deduped areas, added
`line_area_region_map` / `line_zones` / `line_zone_regions` + `employees.region_code`, repointed
~104 employees) was **fully rolled back on 2026-07-07** at the owner's request. The three unification
tables are **dropped**, and **`employees.region_code` was DROPPED** — nothing reads it. **Sales scope
resolves via `employees.region_name` (NOT region_code) → `regionCodesForNames`.** Do not reintroduce the
unification tables or `region_code`.

Left deliberately in the "restored" state (owner-chosen, **do NOT re-clean without his OK**): some
employees sit on **cross-line borrowed area rows** — that is the shared-geography design, not a defect
([[organogram-3line-reconciliation-2026-07]]) — plus a few leftover `ai_*`/`pd_mahalla` reconciliation
rows the revert couldn't delete because employees still occupy them. Only a few national/product roles
(NSMs "Egypt", an RM "Alexandria + Delta", PMs) have a `region_name` unmatched to the master; they don't
scope by region, so it is not a gap.

## Durable facts this surfaced

- 🔴 **The organogram renders EXCLUSIVELY from `position_vacancies` rows.** An active `areas` row with
  **0 employees AND 0 vacancy rows is invisible** — not even shown as vacant (this is what hid "Anti
  Infective Tanta"). To make an empty structure seat appear, open a `position_vacancies` row for it; that
  is purely additive. Same four-layer lesson as [[organogram-3line-reconciliation-2026-07]].
- 🔴 **A "team" is a region/DSM grouping that spans MANY areas BY DESIGN** ("Delta 1" ~12 areas, "Upper
  Egypt" ~9; ~85 team rows, ~13 distinct names). The employee-import validator was deliberately relaxed so
  a known team name under a NEW area **auto-creates an area-scoped team instead of hard-blocking** — **do
  NOT re-add a one-area-per-team block** (`src/lib/imports/employee-validator.ts`).
- 🔴 **Head-Office confidentiality rests on a hardcoded line keyset** `HEAD_OFFICE_LINE_KEYS` in
  `access-scope.ts` — one divergent import label ("H.O." etc.) would leak the 77k HO rows to every
  non-exec role. Backstopped at write time: `MasterColumn.allowedValues` + `OFFICIAL_LINE_VALUES` /
  `resolveOfficialLineValue` (single source `OFFICIAL_LINE_BY_KEY`) wired to the products `line` column
  across all three write paths in `master-data/import-service.ts`, so an unrecognized Line value BLOCKS
  the import. Pinned in `tests/sales-restricted-products.test.ts`.
- 🔴 **RM / DSM / line scope FAILS CLOSED to empty on any `region_name` / line-name drift** — zero margin
  (100% matched today, so a single relabel silently empties a manager's scope). Treat a region_name or
  line-name rename as a scope-breaking change.
- **The Source-of-Sales master is a SEPARATE namespace** — geography modules resolve via `region_name` +
  integer FKs; nothing reads `areas.code`/`lines.code` in a revert-breaking way
  ([[sos-brick-authoritative-geography]]).
- **`employees.line_name` is NOT dead** — read by three prod views (`v_active_organogram`,
  `v_probation_tracker`, `v_employee_portal_payslips`), 0 drift from `lines.name`
  ([[employees-line-name-not-line]]).

## Verification traps (durable)

- **Diagnose against a worktree off current `origin/main`, not the primary's stale branch** — the primary
  was on a pre-revert branch that still held dead territory-mapping code, which made a grep look like a
  live break ([[stale-checkout-verify-against-origin-main]]).
- **MCP `apply_migration` records the ledger row under an MCP timestamp, not the file version**, so the
  ledger drifts from the migration files; relabel with an UPDATE that preserves `statements`. Worse, a
  migration applied direct-to-prod via MCP **with no matching PR** can silently no-op parts of a later
  "official" revert — so **make a migration replay-safe** (re-create any row it depends on before using
  it) ([[mcp-apply-migration-version-drift]]).

Related: [[company-org-structure-head-office]].
