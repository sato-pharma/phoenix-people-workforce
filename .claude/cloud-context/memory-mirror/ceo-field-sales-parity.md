---
name: ceo-field-sales-parity
description: "CEO NSM-parity build (2026-07-05) — /admin/field-sales/* re-hosts portal dashboards company-wide; shared per-line builders guarantee reconciliation; key gotchas."
metadata: 
  node_type: memory
  type: project
  originSessionId: b0dc33c3-69c2-4340-82b1-c72ba656a84b
---

CEO account mirrors the NSM surface at company scope via `/admin/field-sales/*` (branch `codex/ceo-nsm-parity`, worktree `F:\Phoenix Workforce\_wt-ceo-nsm-parity`):

- **Re-hosted portal dashboards** (same client components + loaders, CEO AccessContext → COMPANY scope): weekly-sales, source-of-sales, plus `/admin/company-calendar`. Double-Visit Analytics was ALREADY company-wide for CEO at `/admin/double-visit-analytics` — never rebuild it.
- **Shared per-line builders** in `src/lib/employee-portal/service.ts`: `buildDsmPerformanceForLineScope` (behind `getNsmDsmPerformance` + `getCompanyDsmPerformance`) and `buildTeamPerformanceForScope` (behind `getDsmTeamPerformance` + `getCompanyMedRepPerformance`). Company totals = Σ per-line NSM views BY CONSTRUCTION — never fork these paths or numbers diverge.
- **API executive allowance**: the 4 portal feeds (`/api/employee-portals/{weekly-sales,source-of-sales}` + `/export`) allow `CEO`/`Super Admin` alongside `isPortalWeeklyRole`/`isPortalSosRole`. The portal PAGE role sets intentionally still exclude CEO (nav-mode keeps CEO out of portal chrome).
- **Company-tier line filter**: `computePortalWeeklyVisibility(role, regions, companyWide)` — third arg true when weekly tier==='full'; `trimWeeklyFilterOptions` keeps `availableLines` for full tier.

**Why:** Rule set from owner: ①accuracy ②simple-yet-analytical ③load/render speed; ADDITIVE ONLY (never remove anything from CEO account).

**How to apply / gotchas:**
- CEO's effective matrix LACKS `hr_calendar` read — gate calendar-ish CEO pages by role (CEO || canAccessSystemAdministratorWorkspace), pattern-match Private Calendars nav entry (`attendance:read`).
- Company-wide SoS RPC payload >2MB breaks Next `unstable_cache` (async unhandledRejection). `fetchSosDashboardRpcRows` in `src/lib/sales/sos-dashboard.ts` bypasses the cache when `canSeeCrossLineGeography && no line restriction`; line-scoped callers stay cached. Phase-3 candidate: slim company cache + React cache() on auth bootstrap; company SoS data tail was ~15s warm in dev.
- `canSeeEmployee` does NOT grant CEO company visibility (only system scope / Super Admin / Training Manager) — company people-loaders gate on `access.scope==='company'` + role, never patch canSeeEmployee (would widen Finance Manager too).

Related: [[dsms-performance-hyphen-stripped-hrid-bug]], [[seat-continuity-resolver]], [[sos-fact-rollup-exec-si-dashboards]], [[ceo-command-center-phase1]]
