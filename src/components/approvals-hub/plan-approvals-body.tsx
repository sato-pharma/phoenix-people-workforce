import { planSourcesUnavailableNotice, type PlanWorkspaceData } from "@/lib/approvals-hub/service";
import { ApprovalsWorkspace, type WorkspaceSection } from "@/components/approvals-hub/approvals-workspace";

export function PlanApprovalsBody({ data }: { data: PlanWorkspaceData }) {
  const sections: WorkspaceSection[] = [
    { key: "awaiting", title: "Awaiting your response", cards: data.awaiting },
    {
      key: "upcoming",
      title: "Coming to you",
      subtitle: "Waiting on an earlier approver — not yet your turn.",
      readOnly: true,
      cards: data.upcoming,
    },
  ];
  return (
    <ApprovalsWorkspace
      sections={sections}
      pendingNotice={planSourcesUnavailableNotice(data.unavailable)}
      history={data.history}
      pendingCount={data.pendingCount}
      slaModule="plan"
      historyExportTitle="Plan Approval History"
      historyEmptyLabel="You have not responded to any weekly/monthly plans yet."
      myRequests={data.myRequests}
      companyWide={data.companyWide}
      companyWideExportTitle="Company-Wide Plan Decisions"
      companyRequests={data.companyRequests}
      companyRequestsTabLabel="Company Plans"
      companyRequestsExportTitle="Company Plans"
      companyRequestsEmptyLabel="No weekly/monthly plans have been submitted yet."
      secondaryCompanyRequests={data.districtManagerRequests}
      secondaryCompanyRequestsTabLabel="District Manager Plans"
      secondaryCompanyRequestsExportTitle="District Manager Plans"
      secondaryCompanyRequestsEmptyLabel="No District Manager plans have been submitted yet."
      scoreHistory={data.scoreHistory}
      scoreHistoryPlanBaseHref={data.planDetailBaseHref}
    />
  );
}
