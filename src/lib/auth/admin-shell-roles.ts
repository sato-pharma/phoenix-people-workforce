// THE EMPLOYEE ROLES WHOSE HOME IS THE ADMIN SHELL, NOT THE EMPLOYEE PORTAL.
//
// permissions.ts builds `isAdminShellEmployeeRole` from this list and re-exports it, so every
// importer of `adminShellEmployeeRoles` from there is unchanged. system-navigation.ts imports it from
// HERE instead, and that is the reason this file exists (26 Oct 2026).
//
// No runtime imports: permissions.ts pulls @/lib/supabase/server in, and system-navigation.ts read
// this one list from it as a VALUE — the only runtime edge from the sidebar's whole definition to a
// database client. That edge kept the sidebar-label snapshot check out of `check-contracts`, so a
// label added without re-measuring was found by CI instead (4 red jobs on 4 branches, 18-25 Oct).
// The type import below is erased at run time. Same shape as portal-shell-roles.ts.
import type { PhoenixRole } from "@/lib/auth/permissions";

export const adminShellEmployeeRoles = [
  "SFE Manager",
  "Finance Manager",
  "Financial Advisor",
  // Owner decision 2026-08-28: the HR seats live on the ADMIN shell, not the employee portal. The
  // portal needs a second copy of every admin tool, and two of those copies shipped unreachable for
  // the seat this replaces.
  "HR Operations",
  // Talent Acquisition, 2026-10-08: the owner chose the admin shell on the access blueprint, the
  // same side as both other HR seats.
  "HR Resourcing",
  // HR Operations Specialist, 2026-10-20: the same HR shell as the other seats.
  "HR Administration",
] as const satisfies readonly PhoenixRole[];
