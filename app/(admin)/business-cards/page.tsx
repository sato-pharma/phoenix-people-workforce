import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BusinessCardsManager } from "@/components/business-cards/business-cards-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listBusinessCardEmployees } from "@/lib/business-cards/service";
import type { BusinessCardEmployee } from "@/lib/business-cards/service";

export const dynamic = "force-dynamic";

// Gated exactly like HR Forms: `employee_documents` and an HR seat. The API route enforces the same.

export default async function BusinessCardsPage() {
  const access = await resolveAccessContextFromPage();
  // Two separate gates, each in the shape the HR seat and navigation guards read from source.
  if (!(await canAccess(access, "employee_documents", "read"))) redirect("/employee-portals");
  if (!isHrAuthorityRole(access.role)) redirect("/employee-portals");

  return (
    <Suspense
      fallback={<AppRouteLoadingState description="Preparing the active staff list." title="Loading Business Cards" />}
    >
      <BusinessCardsContent />
    </Suspense>
  );
}

async function BusinessCardsContent() {
  let employees: BusinessCardEmployee[] = [];
  let initialError: string | null = null;
  try {
    employees = await listBusinessCardEmployees();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "The staff list could not be loaded.";
  }
  return <BusinessCardsManager employees={employees} initialError={initialError} />;
}
