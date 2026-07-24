import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OfferLifecycleDashboard } from "@/components/offers/offer-lifecycle-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getOfferDashboard, type OfferDashboardData } from "@/lib/offers/service";

export const dynamic = "force-dynamic";

export default async function OffersPage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "offers", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing offers, approvals, and acceptance tracking."
          title="Loading Offer Lifecycle"
        />
      }
    >
      <OffersContent />
    </Suspense>
  );
}

async function OffersContent() {
  let data: OfferDashboardData | null = null;
  let initialError: string | null = null;

  try {
    data = await getOfferDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load offer lifecycle data.";
  }

  return <OfferLifecycleDashboard initialData={data} initialError={initialError} />;
}
