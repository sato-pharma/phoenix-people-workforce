---
name: monthly-closing-view-access-four-gates
description: "Who may VIEW the admin Monthly Closing is enforced at 4 separate server gates that must move together; the GET matrix data-feed is the easy-to-miss one — it 403'd SFE Manager on Refresh/line-change while the page rendered fine (fixed #2013, 2026-08-10)"
metadata: 
  node_type: memory
  type: project
  originSessionId: d36ac27e-c833-4541-93f2-16a91191c62a
  modified: 2026-08-12T11:09:58.009Z
---

The admin Monthly Closing workspace (`/sales/monthly-closing`) decides WHO can see it at **five
independent server gates that must agree** — changing one without the others is the trap:

0. **Navigation mode — FIRST, and it is the one that ends most conversations.**
   `page.tsx` opens with `if (resolveNavigationMode(access) === "employee-portal") redirect(...)`,
   which fires **before any role or permission check**. `portalNavigationRoles` (permissions.ts
   ~L191) holds Employee, Medical Rep, District/Regional/National Sales Manager, Product Manager,
   Group Product Manager, **Marketing Manager**, Training Manager, CEO, Manager, Talent Acquisition
   — CEO is then special-cased back to `admin`. **For any other role on that list this URL is
   unreachable, full stop**, and the only ways onto it are removing them from `portalNavigationRoles`
   (which moves their WHOLE account to the admin shell and takes every portal tab with it) or a
   per-page carve-out. Verified 2026-08-12. When the owner asks for "the /sales/monthly-closing tab"
   for a portal role, the answer is the portal tab `/employee-portals/monthly-closing`, not this URL.
1. **Page** `app/(admin)/sales/monthly-closing/page.tsx` — `isSystemAdministratorViewer || role === "SFE Manager"`; `canPublish={isSystemAdministratorViewer}` (role-conditional, never the bare `canPublish`).
2. **On-screen matrix DATA FEED** `GET /api/sales/monthly-closing/route.ts` — the workspace calls this on **Refresh and on every Line/Month change** (`reload()` in `src/components/sales/monthly-closing-workspace.tsx`). The selected line is derived from its response, so a 403 here ALSO snaps the user back to the default line — they can't switch lines or export another line's sheet.
3. **Export** `POST /api/sales/monthly-closing/export/route.ts` — a role disjunction (SA / system / SFE Manager / CEO / Finance Manager) selects the FULL-workbook branch; every other sales role falls to a scoped Details-only workbook.
4. **Publish + Lock** `publish/route.ts` + `lock/route.ts` — independently hard-gated to Super-Admin/system and MUST stay so (pinned by `tests/sfe-manager-nav-dead-links.test.ts` (5) and `tests/monthly-closing-lock.test.ts`). `/details` is separate again: `sales:read` for every sales role, confidential-stripped.

**The bite (2026-08-10, #2013 / commit `8c8caa65`):** SFE Manager was opened to gates 1 + 3 and the nav card on 2026-08-05, but gate 2 was left Super-Admin-only. His matrix drew once (the PAGE server-renders the first view) then 403'd *"Forbidden: Monthly Closing is restricted to the admin account"* the instant he hit Refresh or changed line. A smoke test on first load looks fine — that is why it slipped for months. Fix = add SFE Manager to gate 2; pinned by a NEW assertion (8) in `tests/sfe-manager-nav-dead-links.test.ts` (gate 2 was the one closing surface that suite never covered).

**Confidential stays safe by construction for any role admitted to the VIEW:** `listMonthlyClosingLines()` excludes the Head Office line for every viewer and the loader only accepts a line in that list, and the closing RPCs exclude the restricted product codes (LA003/LA004/SS001) in SQL — so opening the closing to a new role leaks neither the confidential line nor the restricted SKUs. See [[restricted-skus-are-all-head-office-line]].

**How to apply:** for "role X can't see/use Monthly Closing though the sidebar shows it," enumerate ALL five gates before concluding — check **gate 0 first** (is X a portal-navigation role? then this URL was never reachable and no amount of role-list editing changes that), then **gate 2**, because the page's server-render hides its absence until the user interacts. Same enumerate-every-gate discipline as [[weekly-plan-four-gates-rm-dsm]] and [[changing-a-user-role-needs-four-writes]].
