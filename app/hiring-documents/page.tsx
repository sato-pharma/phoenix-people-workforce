import { redirect } from "next/navigation";

import { HiringDocumentsManager } from "@/components/hiring-documents/hiring-documents-manager";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
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
  if (!(await canAccess(access, "employee_documents", "read"))) {
    redirect("/employee-portals");
  }

  let initialData: HiringDocumentsDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = filterHiringDocumentsForAccess(await getHiringDocumentsDashboard(), access);
  } catch (error) {
    initialError = hiringDocumentsPageError(error);
  }

  return (
    <AppShell navigationMode="admin">
      <HiringDocumentsManager
        canManage={await canAccess(access, "employee_documents", "update")}
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
