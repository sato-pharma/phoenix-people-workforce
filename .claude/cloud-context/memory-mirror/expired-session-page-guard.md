---
name: expired-session-page-guard
description: "Pages that assertPermission after resolveAccessContextFromPage need a guest-fallback guard, else expired sessions throw a misleading \"Forbidden\" + broken render."
metadata: 
  node_type: memory
  type: project
  originSessionId: 68d7ba56-d3bb-4d18-8f81-e77a6b01dbf8
---

**Bug (found 2026-07-16 while auditing null-hr_id errors in System Issues):** when a session expires between a route-group layout's auth check and a page's client-navigated render, `resolveAccessContextFromPage()` returns a GUEST FALLBACK — role `"Employee"`, `hrId`/`loginId` **null**. A page that then calls `assertPermission(...)` throws a misleading **`Forbidden: Employee cannot read X`** plus a broken Server-Components render (client sees "An error occurred in the Server Components render"), instead of redirecting to `/login`. This was the bulk of un-attributed (`hr_id` null) errors in `app_error_events` — `/payslips` alone: 511 in 30 days. The null identity is inherent (guest fallback has no ids), which is why they never showed in the per-user attempts tab.

**Fix (PR #1079, MERGED aee11d61):** shared page-only guard `resolveAuthenticatedPageAccess()` in `src/lib/auth/page-access.ts` (resolve → if `isGuestFallbackAccess` redirect to `/login`); pure predicate `isGuestFallbackAccess` split into `src/lib/auth/page-access-guard.ts` so it's testable without loading `next/navigation`. Applied to all 47 pages that asserted a permission without the guard. Reference pattern predates this: `app/employee-portals/expense-dashboard/page.tsx` had the inline `if (!access.loginId && !access.hrId) redirect("/login")`.

**How to apply:** any NEW page that does `resolveAccessContextFromPage()` then `assertPermission(...)` should resolve via `resolveAuthenticatedPageAccess()` instead — otherwise it reintroduces this bug. Do NOT import `next/navigation` `redirect` into `server.ts` (used by API routes) — keep it in the page-only module. See [[phx1-system-admin-identity]] (the admin-HR/PHX-1 account whose errors surfaced this during the [[system-issues-dashboard-gcp-supabase]] per-user-attempts work).
