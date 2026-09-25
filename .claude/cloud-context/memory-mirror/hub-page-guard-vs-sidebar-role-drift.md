---
name: hub-page-guard-vs-sidebar-role-drift
description: "Collapsed sidebar \"hub\" buttons can show a role a button whose page-guard then redirects them away — sidebar gate vs page redirect drift"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7c977f70-d016-4148-9271-9d169f3671da
---

The admin sidebar collapses many tool groups into a single "hub" button (Source of Sales, Weekly Sales, Sales Analytics, Master Data, etc. — see `sourceOfSalesPageItems`/`hubPageItemGroups` in `src/config/system-navigation.ts`). Each hub button has its OWN role gate in the nav config, and the hub PAGE (`app/(admin)/sales/<hub>/page.tsx`) has a SEPARATE runtime redirect guard (often a local `*_EXCLUDED_ROLES` constant). These two can drift out of sync: the sidebar shows a role the button, but the page then `redirect()`s them away — usually to `/employee-portals`, which is especially wrong for admin-shell roles (CEO/Super Admin, `resolveNavigationMode === "admin"`).

Concrete instance fixed: CEO's "Source of Sales" tab → page's `SOURCE_OF_SALES_EXCLUDED_ROLES` still listed "CEO" while the sidebar button + the `/sales` dash gate had already dropped CEO. Clicking bounced CEO to the employee portal. Fix: PR #1092 (branch `codex/ceo-source-of-sales-redirect-fix`) removed "CEO" from that constant — **MERGED + deployed to production 2026-07-17** (merge f682277c, Cloud Run revision phoenix-hr-00234-xud serving 100%). Proven via local curl A/B on the exact commit: buggy code → RSC redirect to `/employee-portals`; fixed code → renders the "Source of Sales Dash" card.

**Why:** `tests/ceo-account-contract.test.ts` (and nav tests generally) assert access via `getSections(...)` — that's SIDEBAR VISIBILITY only. They never execute the page component's redirect, so page-guard drift passes CI silently.

**How to apply:** When auditing/adding a hub button's role gate, check BOTH the nav-config gate AND the hub page's own `*_EXCLUDED_ROLES`/redirect. Keep them consistent. Add a source-level assertion (readFileSync + regex on the page's exclusion constant) alongside the `getSections` check — see the pattern added to `ceo-account-contract.test.ts` in #1092. Related: [[expired-session-page-guard]], [[admin-shell-role-page-gate-bug]], [[portal-sidebar-real-source]].
