import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ManagerEngagementView } from "@/components/recruitment/manager-engagement-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewManagerCvEngagement, loadManagerCvEngagement } from "@/lib/recruitment/manager-cv-engagement";
import { fenceManagerEngagementReport } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/manager-engagement/page.tsx. A National Sales Manager
// works out of the employee portal, not the admin shell, so without this twin the silent report is
// unreachable for three of the five people it is for. loadManagerCvEngagement scopes him to his own
// line — a National Sales Manager sees only the managers on his line, never the whole company — so
// the page needs no extra scoping of its own.
//
// The manager whose opens this counts never reaches this page: canViewManagerCvEngagement admits
// only Super Admin, CEO and National Sales Manager. A District Manager — the role most often being
// measured — lands on the empty state, and his own "My Candidates" portal shows nothing about being
// tracked. That is the silence the feature is built around.
export default async function EmployeePortalManagerEngagementPage() {
  const access = await resolveAccessContextFromPage();

  // Super Admin and CEO resolve to the admin shell — send them to the admin twin.
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/manager-engagement");
  }
  if (!canViewManagerCvEngagement(access)) {
    return (
      <EmployeePortalEmptyState
        message="This report is available to the CEO and National Sales Managers only."
        title="Report Unavailable"
      />
    );
  }

  const everyone = await loadManagerCvEngagement(access);
  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is neither listed nor counted.
  // The two people this page admits never hide HR people, so this returns at once for them.
  const report = await fenceManagerEngagementReport(access, everyone);

  return (
    <EmployeePortalPageShell
      badge="Hiring"
      description="For every manager on your line: how many CVs are in their My Candidates folder, how many they opened, how many are still unopened, and how many they answered."
      errorBoundaryTitle="Manager engagement unavailable"
      title="Manager CV Engagement"
    >
      <ManagerEngagementView report={report} />
    </EmployeePortalPageShell>
  );
}
