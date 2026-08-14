import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { CvExtractionAnalyticsView } from "@/components/recruitment/cv-extraction-analytics-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewCvExtractionAnalytics } from "@/lib/recruitment/access";
import { getCvExtractionAccuracyAnalytics } from "@/lib/recruitment/cv-extraction-analytics";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/cv-extraction-analytics/page.tsx — same data, same
// gate, wrapped in the employee-portal shell instead of the admin shell. Kept in sync by hand,
// exactly like the CV Review Queue pair next door.
//
// Without this file the dashboard was unreachable by the only role whose behavior it measures.
// Talent Acquisition is in portalNavigationRoles, so resolveNavigationMode puts them in the portal
// shell; app/(admin)/layout.tsx redirects portal-mode users out of the whole admin group, and the
// admin copy repeats that redirect on its own first line. The net effect was a page about Talent
// Acquisition's correction rate that only Super Admin could open, listed on a hub
// (app/(admin)/admin/recruitment-hiring/page.tsx) that Talent Acquisition also cannot open.
// tests/recruitment-hub-portal-coverage.test.ts now fails if a hub tool ships without a mirror.
export default async function EmployeePortalCvExtractionAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/cv-extraction-analytics");
  }
  if (!canViewCvExtractionAnalytics(access)) {
    return (
      <EmployeePortalEmptyState
        message="CV extraction accuracy is available to Talent Acquisition and Super Admin only."
        title="CV Extraction Accuracy Unavailable"
      />
    );
  }

  let data;
  try {
    data = await getCvExtractionAccuracyAnalytics();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return <EmployeePortalEmptyState message={message} title="CV Extraction Accuracy Unavailable" />;
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Reviewed extractions only. How often each proposed CV field was corrected before saving, by position — a high correction rate flags a field worth revisiting."
      errorBoundaryTitle="CV extraction accuracy unavailable"
      title="CV Extraction Accuracy"
    >
      <CvExtractionAnalyticsView data={data} />
    </EmployeePortalPageShell>
  );
}
