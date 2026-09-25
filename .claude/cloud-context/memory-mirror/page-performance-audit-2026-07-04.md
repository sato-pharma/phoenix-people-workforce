---
name: page-performance-audit-2026-07-04
description: "Front-end page-speed audit (portal/dashboards/shell): #1 free win is React cache() on the auth bootstrap (runs 2-3x/nav); verified facts + honest measurement caveat."
metadata: 
  node_type: memory
  type: project
  originSessionId: be16768f-c208-447f-be4f-1cf91b93e99a
---

Max-effort 18-agent page-performance audit (2026-07-04) across Employee Portal, Admin Dashboards, Admin Shell. Read code + live DB timings, no edits (another session active). Report Artifact published. Findings verified by reading the real tree; **ms figures are ESTIMATES (no live Lighthouse/RUM run) — the hard number is "round-trips removed"; add Server-Timing to a preview before promising ms.**

**#1 cross-cutting win (all surfaces):** wrap the per-request auth bootstrap in React `cache()`. Confirmed: NO `import { cache } from 'react'` anywhere in src/lib/auth; the route-group layout AND the page both call resolveAccessContextFromPage independently, so the 3-query serial session chain (validateAppSession → app_auth_users → employees lifecycle gate, server.ts:180-337) runs 2-3x per navigation. Wrap resolveAccessContextFromPage + resolveViewerIdentityFromPage (server.ts:381,429). **Leave resolveSessionState RAW** — the heartbeat (heartbeat/route.ts) calls it directly and refreshIdle is a mutation that must not be memoized. Removes ~4-6 DB round-trips/nav.

**Portal:** landing blocks on a wide snapshot with NO streaming; the purpose-built streaming helper `getMrHomeStats` (home-snapshot.ts:157) already exists with count(head:true) code but has ZERO callers (dead) — wire it into a Suspense child. DSM/NSM landing loads 3+ whole admin dashboards (incl. select('*') + directory join) for one approvals-count integer → replace with 4 parallel count(head:true). Portal shell built TWICE per landing (layout + home-snapshot.ts:253 both call getEmployeePortalShellData) → cache() it (same-tier quick win as #1).

**Dashboards:** SoS fires 3 multi-second aggregates on first paint (selected+MoM+YoY, ~42s max in prod) and caches NOTHING (exactly 1 unstable_cache in the whole codebase). Fix: unstable_cache the phx_exec_* results keyed FAIL-CLOSED on (period, scope, filters, revealRestricted), bust on rollup refresh; fetch only current month on first paint; nested Suspense (copy CEO center pattern ceo-command-center/page.tsx:90-96); lazy-load recharts via next/dynamic (20 importers, none deferred). CEO center recomputes its 9-aggregator platformMetrics twice → cache().

**Shell:** getEffectiveSidebarModuleIds (app-shell.tsx:53, modules-control.ts:695-697) does a serial per-candidate probe (user>role>position>line, ~4-6 round-trips) uncached → batch into one IN() query preserving precedence (add a unit test) + 30s TTL cache busted on edit. AppShell serializes two independent awaits (viewer identity + modules) → Promise.all.

**VERIFIED do-not-chase:** proxy.ts is lean — pure in-memory CSRF, ZERO DB calls, matcher only /api/* + 2 offer routes (NOT page navs). Permission matrix (permissions.ts:891-1004) is a module-level 30s TTL cache + in-flight dedup — one role_permission_overrides read amortized, not per-page. (Both re-read by hand to close the critic's gaps.) Serverless caveat: module-level caches (directory, matrix, new module cache) warm per-instance, reset on cold start — expected, not a bug.

Locked rules honored: no salary on portal landing (home-snapshot.ts:371-386 computes latestPayslip — keep off landing); don't touch identity-card. Related: [[supabase-deep-audit-2026-07-04]], [[portal-overview-dashboard-build]], [[admin-route-group-shell]], [[vercel-workspaces-and-smi-flag]].

**STATUS 2026-07-04:** #1 win (auth cache()) ALREADY DONE on main — a PARALLEL session shipped it (resolveAccessContextFromPage/resolveViewerIdentityFromPage are cache()-wrapped; resolveSessionState left raw). Recharts lazy-load (#20/#28) in flight on branch codex/perf-frontend-lazyload-virtualization (unmerged, ~16 chart files). CEO SMI fast-path routing shipped (PR #805 merged). Recurring rate-limit prune shipped (PR #806 merged — pruneExpiredRateLimitBuckets() in /api/notifications/daily). Portal streaming (#21 — getMrHomeStats still dead/uncalled) and portal-shell cache() (#23 — getEmployeePortalShellData not yet wrapped) still OPEN. **LESSON: this repo runs an active perf SWARM — ALWAYS grep origin/main + `git worktree list` branches before implementing a front-end item, or you duplicate merged work (nearly did on the auth cache()).**
