---
name: a-new-portal-route-needs-its-companion-declarations
description: Adding a new employee-portal route or sidebar entry trips three separate CI companion contracts in the required validate job; declare all of them up front or validate goes red one at a time
metadata:
  node_type: memory
  type: project
  originSessionId: 8126b70e-3be4-4e48-b935-19e32fed6427
  modified: 2026-09-30T06:55:23.679Z
---

Adding a NEW employee-portal sidebar entry / route means editing SEVERAL files, and three of them
are enforced by contract tests in the required `validate` job. Miss one and `validate` goes red —
and it fails **one at a time**, so a session that only reacts to the current red pays a full CI
cycle per missing file. Declare all of them in the first push. Cost 3 CI rounds on #4853 (My
Milestones), 2026-09-30.

The one-per-CI-round companion contracts:
1. **A new `app/api/**/route.ts`** must have an entry in `src/lib/security/access-registry.ts`.
   Pinned by `tests/access-registry-coverage.test.ts`. A self-scoped / domain-guarded route (gated by
   a role predicate, NOT `assertPermission`/`canAccess`) is declared `permission: null, guard:
   "domain-helper"` — otherwise the coverage test's `missingPermissionGuard` also fires. See
   [[access-registry-is-declarative-and-writes-no-audit-row]].
2. **A new `/employee-portals/**` page** must ship a sibling `loading.tsx` returning
   `<PortalRouteSkeleton shape="…" />` (shape: `table` for a list, `dashboard` for cards, `detail`,
   `form`, `calendar`, `redirect`). Pinned by `tests/portal-route-skeleton.test.ts`.
3. **A new `PORTAL_NAV_REGISTRY` entry** (`employee-portal-nav-registry.ts`) must have a
   `MODULE_PLACEMENT` entry in `src/lib/employee-portal/native-module-directory.ts`, filed under the
   SAME sidebar section the rail files it in, with a real Ionicons name. Pinned by
   `tests/mobile-module-directory.test.ts`. 🔴 This file is `src/lib/...`, NOT under `mobile/`, so it
   is shared web-app config — editing it is NOT the frozen mobile app and the mobile-freeze guard
   does not block it. Skipping it just blocks the WEB PR.

Plus the already-known wiring (these fail other guards, not always in `validate`): the rail row in
`buildEmployeePortalSections` (`employee-portal-layout.tsx`); the `PORTAL_NAV_REGISTRY` entry itself
(no `permission` field when the page has no machine-readable gate, or `every-offered-link-opens` /
`employee-portal-nav-permission-matches-page` fire); the catalog seed in `system-navigation.ts`
(`employee-portal-nav-catalog-sync`); and measured bottom-bar label widths in
`tests/fixtures/sidebar-label-widths.json` (`employee-portal-bottom-nav`). See
[[portal-nav-registry-one-way-sync-test]] and [[portal-sidebar-real-source]].

**How to apply:** before the first push of a new portal route, add ALL of: access-registry entry (if
it has an API route), `loading.tsx`, rail row, nav-registry entry, MODULE_PLACEMENT, catalog seed,
and — if the bottom-bar label is new — a measured width. Then run the registry-driven contracts
locally (they are source+matrix, DB-free) so you catch every companion at once instead of over
several red CI rounds.
