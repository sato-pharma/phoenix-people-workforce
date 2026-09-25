---
name: ceo-command-center-phase1
description: "CEO Command Center — LIVE on main at /admin/ceo-command-center as the CEO landing (PR #408, 2026-06-21). Reuses the admin command center; gated CEO+Super Admin."
metadata:
  node_type: memory
  type: project
  originSessionId: c9a0b32f-31e2-4e38-bd17-a41e281acfb0
---

CURRENT TRUTH (2026-06-21, PR #408 MERGED to main, commit 1d6b10d2): the CEO Command Center is live at **/admin/ceo-command-center** and is the **CEO's landing page**.

Implementation (deliberately minimal, reuses the proven system-admin surface):
- Page `app/(admin)/admin/ceo-command-center/page.tsx` reuses `getAdminCommandCenterData` + the `AdminCommandCenter` component (already role-scoped for the CEO — CEO has admin:read+overview:read+company payroll summary). Gated to **CEO + Super Admin** (server-side; sidebar visibility is never the boundary). Branded via a new optional `surfaceLabel` prop on AdminCommandCenter ("CEO Command Center").
- **`/admin` redirects role==="CEO" → /admin/ceo-command-center** so the shared "Command Center" sidebar link routes the CEO there. NO separate nav item was added: `excludedRoles` is intentionally ignored in admin mode (locked by [navigation-active-path.test.ts] "admin mode: excludedRoles ignored"), so you can't hide the generic /admin item from the CEO via exclusion — the redirect is the clean lever. Super Admin keeps /admin.
- Landing: `resolveLandingPathForRole("ceo")` → "/admin/ceo-command-center" (was "/sales"). Sales Command stays in the sidebar.
- Test: `tests/ceo-command-center.test.ts` locks the CEO landing (others unchanged).
- Built on top of #403. Verify visually with a CEO login on PROD (worktree/preview lack Supabase env).

HISTORY (so the loop is clear): a 2026-05-30 "Phase 1" built a BESPOKE `src/components/admin/ceo-command-center.tsx` on branch codex/ceo-phase1 — it was committed but **never merged**, and a later sales-command rebuild (#65) removed /admin/ceo-command-center and pointed the CEO at /sales. #408 re-establishes the route with the simpler reuse-the-admin-center approach above. There is no bespoke ceo-command-center.tsx in the shipped version.
