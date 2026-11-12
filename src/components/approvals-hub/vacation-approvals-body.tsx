import type { VacationWorkspaceData } from "@/lib/approvals-hub/service";
import { ApprovalsWorkspace, type WorkspaceSection } from "@/components/approvals-hub/approvals-workspace";

export function VacationApprovalsBody({ data }: { data: VacationWorkspaceData }) {
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
      history={data.history}
      pendingCount={data.pendingCount}
      slaModule="leave"
      bulkDecisionModule="leave"
      historyExportTitle="Vacation Approval History"
      historyEmptyLabel="You have not responded to any leave requests yet."
      myRequests={data.myRequests}
      companyWide={data.companyWide}
      companyWideExportTitle="Company-Wide Vacation Decisions"
      approvalScope={data.approvalScope}
      approvalScopeModuleLabel="vacation"
      companyRequests={data.companyRequests}
      companyRequestsExportTitle="Company Vacation Requests (excl. DM & Medical Rep)"
      companyRequestsEmptyLabel="No vacation requests found (excluding District Managers and Medical Reps)."
    />
  );
}
