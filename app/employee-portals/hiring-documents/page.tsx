import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HiringDocumentsManager } from "@/components/hiring-documents/hiring-documents-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, isHiringPaperworkRole, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
  mayEditHiringChecklist,
  mayRemoveHiringDocumentFile,
} from "@/lib/hiring-documents/service";
import type { HiringDocumentsDashboardData } from "@/lib/hiring-documents/types";

export const dynamic = "force-dynamic";

function hiringDocumentsPageError(error: unknown) {
  if (isHiringDocumentsSchemaMissing(error)) {
    return "Hiring documents schema is not ready. Run the Supabase migration for hiring documents.";
  }
  return hiringDocumentsErrorMessage(error);
}

// Portal mirror of app/(admin)/hiring-documents/page.tsx.
export default async function EmployeePortalHiringDocumentsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/hiring-documents");
  }
  const [canRead, canManage] = await Promise.all([
    canAccess(access, "employee_documents", "read"),
    canAccess(access, "employee_documents", "update"),
  ]);
  if (!isHiringPaperworkRole(access.role) || !canRead) {
    return (
      <EmployeePortalEmptyState
        message="Hiring documents are available to the HR Generalist, the HR Operations Specialist and the Super Admin only."
        title="Hiring Documents Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
      description="Onboarding document readiness and employee status."
      errorBoundaryTitle="Hiring Documents unavailable"
      title="Hiring Documents"
    >
      <Suspense
        fallback={
          <AppRouteLoadingState
            description="Preparing onboarding document readiness and employee status."
            title="Loading Hiring Documents"
          />
        }
      >
        <HiringDocumentsContent access={access} canManage={canManage} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function HiringDocumentsContent({
  access,
  canManage,
}: {
  access: AccessContext;
  canManage: boolean;
}) {
  let initialData: HiringDocumentsDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = filterHiringDocumentsForAccess(await getHiringDocumentsDashboard(), access);
  } catch (error) {
    initialError = hiringDocumentsPageError(error);
  }

  return (
    <HiringDocumentsManager
      canEditChecklist={canManage && mayEditHiringChecklist(access)}
      canRemoveFiles={canManage && mayRemoveHiringDocumentFile(access)}
      canManage={canManage}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
