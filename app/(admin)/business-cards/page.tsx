import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BusinessCardsManager } from "@/components/business-cards/business-cards-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canPrintBusinessCards } from "@/lib/business-cards/access";
import { listBusinessCardEmployees } from "@/lib/business-cards/service";
import type { BusinessCardEmployee } from "@/lib/business-cards/service";

export const dynamic = "force-dynamic";

// Gated by canPrintBusinessCards — an HR seat holding `employee_documents` (as HR Forms), or the
// Talent Acquisition seat through the business-card request desk. The API route calls the same predicate.

export default async function BusinessCardsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canPrintBusinessCards(access))) redirect("/employee-portals");

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
  let requestsUnread = false;
  let initialError: string | null = null;
  try {
    ({ employees, requestsUnread } = await listBusinessCardEmployees());
  } catch (error) {
    initialError = error instanceof Error ? error.message : "The staff list could not be loaded.";
  }
  return <BusinessCardsManager employees={employees} initialError={initialError} requestsUnread={requestsUnread} />;
}
