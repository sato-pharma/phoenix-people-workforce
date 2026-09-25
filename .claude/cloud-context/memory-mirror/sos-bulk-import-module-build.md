---
name: sos-bulk-import-module-build
description: "New \"Bulk Import\" mode on /sales/upload — multi-distributor grid, shared month, zero changes to existing analyze/commit/ai-suggest business logic"
metadata: 
  node_type: memory
  type: project
  originSessionId: eb2b3b7b-8795-4ebe-84cf-604557d06837
  modified: 2026-07-24T06:11:48.378Z
---

Built a new "Bulk Import" mode on `/sales/upload` (toggle next to the existing "Single
distributor" mode), per owner spec 2026-07-24: pick one month, see every monthly
distributor as a horizontal card, click any to open an upload slot. Each slot is the
exact same `MonthlyUpload` component/AI-verify → strict-validate → confirm flow as the
single-distributor page — same `analyze`/`commit`/`detect` API calls, untouched. Cards
live-color (grey/amber/green/red) via a new `onStatusChange` callback prop, and
`MonthlyUpload` is now a `forwardRef` exposing its existing `commit()` so "Confirm &
Import All" can trigger each ready slot's own commit without duplicating commit logic.
The confirm step shows a per-distributor product×qty table plus one consolidated
(summed-across-distributors) table. Added an "AI suggest" button (same Sparkles-icon
pattern as the Normalizer page) into the existing inline `UnmappedList` mapping panel —
scoped to product + territory only, via the existing non-gated
`/api/sales/monthly-import/ai-suggest` route (same `sales:import` permission the upload
page already requires). Customer mapping stays manual-only there: the richer geo pipeline
(`suggestCustomerBricks`) is deliberately Super-Admin-gated on the Normalizer route, and
broadening that access wasn't asked for — see [[sos-dashboard-rebuild-2026-07-02]] /
[[normalizer-godmode-customer-mapping]] for that pipeline's context.

**Why:** owner wanted bulk multi-distributor upload without touching business logic —
this is pure UI orchestration over existing analyze/commit/detect/save-mappings/ai-suggest
endpoints; no recognition/validation/commit rule was duplicated or changed.

**Where:** built in isolated worktree `F:\Phoenix Workforce\_wt-sos-bulk-import`, branch
`codex/sos-bulk-import` (off `origin/main` 2026-07-24), because the primary checkout had
another session's uncommitted recruitment-CV-extraction work in progress on
`codex/recruitment-cv-ai-extraction` at the time — see [[parallel-work-model-2026-07]].
New file: `src/components/sales/bulk-import-workspace.tsx`. Modified:
`src/components/sales/sales-upload-workspace.tsx` (exported shared types/helpers,
`MonthlyUpload` → forwardRef + new `initialPeriod`/`onStatusChange`/`aiEnabled` props,
`commit` wrapped in `useCallback`), `app/(admin)/sales/upload/page.tsx` (passes
`aiEnabled={hasAiKey()}`).

**How to apply:** typecheck/lint/full 431-file test suite all pass. Browser-verified live
in the worktree's own dev server (mode toggle, month-picker gating, per-card click
open/collapse with state persisted via CSS-`hidden`-not-unmounted slots so switching
cards doesn't lose progress, per-slot period correctly seeded from the shared month,
"Confirm & Import All" correctly disabled until every touched slot is ready). See
[[react-hooks-refs-lint-rule-during-render]] for a lint gotcha hit while wiring the
per-slot refs/callbacks. Committed + pushed + PR opened 2026-07-24:
https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1300 (still needs owner
review/merge approval — ~~merging deploys via the normal CI → Cloud Run pipeline~~ **[CORRECTED 2026-08-27: merging now ships to PRODUCTION IMMEDIATELY via Railway auto-deploy on push to `main` — no pipeline to wait for, and nothing to dispatch]**). NOT
tested end-to-end through an actual file
upload→commit (no sample distributor .xlsx fixtures exist in the repo, and real writes to
dev Supabase were avoided without need) — that path reuses the single-distributor page's
existing, already-tested code completely untouched, so risk there is low.
