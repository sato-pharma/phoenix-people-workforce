import { redirect } from "next/navigation";

import { AccountActivationWorkspace } from "@/components/employee-portal/account-activation-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listAccountActivationEligibleUsers } from "@/lib/recruitment/account-activation";

export const dynamic = "force-dynamic";

// Talent Acquisition only — a narrow account activate/deactivate tool, deliberately not a
// mirror of /admin/access. See src/lib/recruitment/account-activation.ts.
export default async function EmployeePortalAccountActivationPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  // NOTE (2026-08-28): HR Advisory holds account_activation but is an ADMIN-shell role, so the
  // navigation-mode redirect above returns before this line ever runs. This page has no reachable
  // holder until the /hr namespace (Phase 2) gives it an admin-shell home. Granted-but-unreachable
  // is the one shape tests/every-offered-link-opens.test.ts cannot see, so it is written down here.
  if (access.role !== "HR Advisory" || !(await canAccess(access, "account_activation", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Account activation is available to HR Advisory only."
        title="Account Activation Unavailable"
      />
    );
  }

  let initialUsers: Awaited<ReturnType<typeof listAccountActivationEligibleUsers>> = [];
  let initialError: string | null = null;

  try {
    initialUsers = await listAccountActivationEligibleUsers();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load accounts.";
  }

  if (initialError) {
    return (
      <EmployeePortalEmptyState
        message={initialError}
        title="Account Activation Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Activate or deactivate regular employee accounts. Super Admin, CEO, and Talent Acquisition accounts are never shown here."
      errorBoundaryTitle="Account Activation unavailable"
      title="Account Activation"
    >
      <AccountActivationWorkspace initialUsers={initialUsers} />
    </EmployeePortalPageShell>
  );
}
