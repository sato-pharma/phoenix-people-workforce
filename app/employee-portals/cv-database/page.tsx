import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/cv-database/page.tsx.
export default async function EmployeePortalCvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/cv-database");
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "vacancies", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="The CV database is available to Talent Acquisition and Super Admin only."
        title="CV Database Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Browse and search the candidate CV database."
      errorBoundaryTitle="CV Database unavailable"
      title="CV Database"
    >
      <CvDatabaseManager />
    </EmployeePortalPageShell>
  );
}
