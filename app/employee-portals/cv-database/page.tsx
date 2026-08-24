import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cvLibraryRowsFromCandidates } from "@/lib/cv/cv-library";
import { listCandidates } from "@/lib/recruitment/candidates";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/cv-database/page.tsx — same loader, same rows, so the two shells
// cannot show different candidates.
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

  const rows = cvLibraryRowsFromCandidates(await listCandidates());

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Browse and search the candidate CV database."
      errorBoundaryTitle="CV Database unavailable"
      title="CV Database"
    >
      <CvDatabaseManager rows={rows} />
    </EmployeePortalPageShell>
  );
}
