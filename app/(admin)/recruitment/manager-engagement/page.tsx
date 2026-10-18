import { Eye } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { PageContainer } from "@/components/layout/page-container";
import { ManagerEngagementView } from "@/components/recruitment/manager-engagement-view";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewManagerCvEngagement, loadManagerCvEngagement } from "@/lib/recruitment/manager-cv-engagement";

export const dynamic = "force-dynamic";

// Manager CV Engagement — the SILENT report. For every manager: how many CVs he was sent, how many
// he opened, how many he never opened, how many he answered. The manager being measured must not be
// able to tell — nothing on his own screen changes; see manager-cv-engagement.ts for how that is
// kept true. Access is exactly five people: Super Admin, CEO, and the three National Sales Managers,
// each NSM scoped to his own line. Explicitly NOT SFE.
//
// The admin twin, for the two who work out of the admin shell (Super Admin, CEO). A National Sales
// Manager works out of the portal, so he is sent to the portal twin — the same twin split the
// screening and intake-health pages use, because app/(admin)/layout.tsx redirects portal-shell roles
// out before this page can render.
//
// Deliberately a plain sidebar row, NOT a card on the Recruitment & Hiring hub — a hub card drags in
// four unrelated CI invariants (portal-twin pairing, a browser-measured label width, the mobile
// bottom-nav registry, and a hub-count test) for no more reach than a route and a link already give.
export default async function ManagerEngagementPage() {
  const access = await resolveAccessContextFromPage();

  // A National Sales Manager is a portal-shell role — send him to his own twin, which scopes him to
  // his line. (Super Admin and CEO both resolve to the admin shell and fall through.)
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/recruitment-engagement");
  }
  // Any other admin-shell role — HR, SFE, an ordinary manager — is not on the list of five.
  if (!canViewManagerCvEngagement(access)) {
    redirect("/employee-portals");
  }

  const report = await loadManagerCvEngagement(access);

  return (
    <PageContainer>
      <div className="space-y-6">
        <RecruitmentPageHeader
          badges={<AdminInsightChip tone="slate">Silent report</AdminInsightChip>}
          description="For every manager: how many CVs are in their My Candidates folder, how many they opened, how many are still unopened, and how many they answered."
          icon={<Eye aria-hidden="true" className="h-3.5 w-3.5" />}
          title="Manager CV Engagement"
        />
        <ManagerEngagementView report={report} />
      </div>
    </PageContainer>
  );
}
