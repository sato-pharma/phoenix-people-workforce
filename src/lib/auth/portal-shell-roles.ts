// THE ONE LIST OF ROLES WHOSE HOME IS THE EMPLOYEE PORTAL.
//
// Two answers read it, and they must never disagree:
//   - `resolveNavigationMode` (permissions.ts) — which shell a signed-in viewer is in. The portal
//     home, `/employee-portals`, sends every viewer it calls "admin" to `/overview`.
//   - `resolveLandingPathForRole` (landing.ts) — where `/overview` and sign-in send a role. Every
//     role on this list is sent to `/employee-portals`.
// Until 2026-09-21 each file kept its own copy. A role on the landing copy but not the navigation
// copy would bounce between `/overview` and `/employee-portals` on every sign-in — every hop a full
// server render, the failure that grew a dev server to 9.9 GB that morning on the expense pages.
// Nothing tied the two copies together; `tests/portal-shell-roles.test.ts` now does.
//
// No runtime imports: landing.ts is bundled into client components (the login page, the sidebar),
// so this file must not pull permissions.ts and its server-side clients in after it. The type
// import below is erased at build time.
import type { PhoenixRole } from "@/lib/auth/permissions";

// The CEO is not here: an executive Admin account on the admin shell, which both callers also
// say explicitly before they reach this list.
export const portalShellRoles = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
  "Manager",
] as const satisfies readonly PhoenixRole[];

const portalShellRoleKeys = new Set<string>(portalShellRoles.map((role) => role.toLowerCase()));

/** Case-insensitive, so the landing path (which lower-cases a raw role string) reads it too. */
export function isPortalShellRole(role: string | null | undefined): boolean {
  return portalShellRoleKeys.has(String(role ?? "").trim().toLowerCase());
}
