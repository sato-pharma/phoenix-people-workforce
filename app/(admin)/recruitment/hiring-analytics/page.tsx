import { BarChart3 } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { PageContainer } from "@/components/layout/page-container";
import { HiringAnalyticsView } from "@/components/recruitment/hiring-analytics-view";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadHiringAnalytics } from "@/lib/recruitment/hiring-analytics";

export const dynamic = "force-dynamic";

// Hiring Analytics — where candidates come from, how well each channel does, and where the pipeline
// actually stops.
//
// The number this page exists to correct: the ATS plan carried "email converts at 50% against
// WhatsApp's 16%" and recommended moving recruitment spend. That figure counted one automated
// sweep over 65 candidates as 65 screening decisions. Excluding sweeps it is 23.8% against 18.4% —
// and email takes about four times longer to give anyone an answer, so the speed column sits beside
// the rate rather than on a second screen.
//
// Deliberately a plain sidebar row, NOT a card on the Recruitment & Hiring hub — the same choice
// manager-engagement made and for the same reason: a hub card drags in four unrelated CI invariants
// (portal-twin pairing, a browser-measured label width, the mobile bottom-nav registry and a
// hub-count test) for no more reach than a route and a link already give.
//
// No portal twin, because there is no portal audience: this reads across EVERY candidate, so it is
// for the people who already see the whole pool. A portal-shell role is sent back rather than shown
// a company-wide report scoped to nobody.
export default async function HiringAnalyticsPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // loadHiringAnalytics asserts `candidates: read` itself — the assertion lives in the domain
  // module rather than here so a second caller cannot inherit an unguarded read of the whole pool.
  const report = await loadHiringAnalytics(access);

  return (
    <PageContainer>
      <div className="space-y-6">
        <RecruitmentPageHeader
          badges={<AdminInsightChip tone="slate">Automated sweeps excluded</AdminInsightChip>}
          description="Where candidates come from, how many of them a person actually decided on, how long that took, and where the pipeline stops. Automated sweeps are excluded from every figure."
          icon={<BarChart3 aria-hidden="true" className="h-3.5 w-3.5" />}
          title="Hiring Analytics"
        />
        <HiringAnalyticsView report={report} />
      </div>
    </PageContainer>
  );
}
