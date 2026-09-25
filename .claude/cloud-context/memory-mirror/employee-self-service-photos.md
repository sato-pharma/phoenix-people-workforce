---
name: employee-self-service-photos
description: "Self-service employee profile-photo upload feature — engine + employee UI built (Phase 1), pending prod migration + admin UI (Phase 2)."
metadata: 
  node_type: memory
  type: project
  originSessionId: d47d5e65-699c-4ca6-ab65-0a7635a5729c
---

Feature: every employee can change their own photo from the My Profile tab; HR/Admin can change anyone's. Uploaded photo shows globally (replaces the old hardcoded static map in [[employees-line-name-not-line]]'s sibling `src/lib/employees/profile-images.ts`) with no redeploy.

**Why:** user asked to stop hand-swapping files in `public/images/hr/<HRID>.jpeg` (which needs a dev + redeploy each time). Resolution order everywhere is now: uploaded photo → bundled static photo → initials.

**How it works (built 2026-06-13, branch `codex/hr-specialist-role-cleanup`, main repo tree, NOT committed):**
- Migration `supabase/migrations/20260613120000_employee_self_service_photo.sql`: adds `employees.photo_path` + `photo_updated_at` (nullable, additive) + private Storage bucket `employee-photos` (5MB cap, public=false).
- `src/lib/employees/employee-photo.ts`: storage upload/clear/stream + cached HR-ID→photo map (30s TTL, defensive: empty map if column missing pre-migration) + `uploadedEmployeePhotoUrl()` / `resolveEmployeePhotoSrc()`. Uploaded photos served via same-origin route (bucket stays private; no `next.config` remotePatterns needed).
- Routes: `app/api/employee-portal/profile-photo/route.ts` (self, `employee_profile:update`), `app/api/employees/[hrId]/photo/route.ts` (GET stream auth-gated; POST/DELETE admin `employees:update` + `canSeeEmployee` scope).
- `employee-portal/service.ts`: `MedicalRepPortalData.employee.photoUrl` added + populated in both shell + dashboard builders.
- `identity-card.tsx`: My Dashboard/profile hero prefers `employee.photoUrl` (rendered `unoptimized` since it's the auth'd same-origin route).
- `employee-photo-editor.tsx` + placed on `app/employee-portals/profile/page.tsx`.
- Validation: `npm run typecheck` + eslint on touched files = GREEN.

**CRITICAL:** localhost `.env` points at PRODUCTION Supabase (`ozucdzovmcqvepbozvqf`) — see [[vercel-preview-env-and-branching]]. Migration APPLIED to prod 2026-06-13 via MCP (name `employee_self_service_photo`); verified: both columns present, `employee-photos` bucket exists (public=false), 0 rows touched. Routes verified live on localhost:3000 (GET photo→404 no-photo, DELETE→CSRF 403, profile page→200).

**Phase 2 DONE:** HR/Admin photo control (`employee-photo-manager.tsx`) added to the master-details panel in `EmployeeManagement`.

**SHIPPED TO PRODUCTION 2026-06-13** via **PR #149** (squash merge `da98820`), verified live at phoenix-workforce.vercel.app: both routes respond with their handlers (GET photo→`{"error":"not_found"}` when no upload; profile-photo DELETE→CSRF 403), A-8.jpeg now 97586 bytes (new photo) on prod, homepage 200. Migration was already applied to prod directly (pipeline no-ops the idempotent file). Worktree + branch cleaned up.

**Gotchas learned:** (1) CI `validate` job runs the FULL test suite incl. `access-registry-coverage.test.ts` — EVERY new `app/api/**/route.ts` method must be added to `src/lib/security/access-registry.ts` or CI fails (typecheck+lint alone miss it; run `npm run test` before pushing a new route). (2) `Supabase Preview` check fails on `main` too — pre-existing/environmental, not a blocker; `main` is NOT branch-protected. (3) Photo priority = **uploaded wins** (user-confirmed); an external editor/parallel session repeatedly reverted local `identity-card.tsx` to static-wins — prod shipped uploaded-wins per user choice.

**Optional follow-ups:** wire admin command-center hero + employee-directory list avatars to `resolveEmployeePhotoSrc` for full global coverage (currently covered: portal My Dashboard/profile hero + admin employee details panel). A-8 still uses its (new) static photo until someone uploads via the new UI.

**Follow-on ships (2026-06-13):**
- PR #150 (squash `f223d107`, verified READY on prod via Vercel `dpl_AgQUiD9...`): removed the big `IdentityCard` hero from the **My Profile** tab — it now renders only on My Dashboard. Profile photo editor + other cards stay.
- A-8 hero photo: already the sent photo on prod via the deployed static `A-8.jpeg` (uploaded→static→initials; A-8 has no DB upload). A direct service-role script to "lock it into the upload system" was BLOCKED by the auto-mode classifier (direct prod DB write, unconfirmed target) — don't retry; use the in-app Upload button or get explicit Bash permission.

**IMPORTANT divergence:** the working branch `codex/hr-specialist-role-cleanup` is STALE vs prod for the attendance tab. It has a "Punch Report" → renamed to "Fingerprint Report" (local only) pointing at an untracked `app/employee-portals/fingerprint-analytics/` page that does NOT exist on `main`. PROD/main already renamed that tab to **"My Attendance"** (PR #146/#147, commits fcab9528/208d7312) on a different route. So the local Punch/Fingerprint rename is moot for prod and that branch's attendance work looks superseded — reconcile/rebase this branch onto main before shipping more from it. Also `access-registry.ts` on this branch predates `double_visit_analytics` resource (typecheck breaks if newest-main version is copied in).
