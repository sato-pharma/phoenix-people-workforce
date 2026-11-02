import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HiringDocumentsManager } from "@/components/hiring-documents/hiring-documents-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHiringPaperworkRole, type AccessContext } from "@/lib/auth/permissions";
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

export default async function HiringDocumentsPage() {
  const access = await resolveAccessContextFromPage();
  const [canRead, canManage] = await Promise.all([
    canAccess(access, "employee_documents", "read"),
    canAccess(access, "employee_documents", "update"),
  ]);

  if (!isHiringPaperworkRole(access.role) || !canRead) {
    redirect("/employee-portals");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Hiring Documents"
          description="Preparing onboarding document readiness and employee status."
        />
      }
    >
      <HiringDocumentsContent access={access} canManage={canManage} />
    </Suspense>
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
