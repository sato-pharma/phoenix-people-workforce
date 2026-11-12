import type { ExcuseWorkspaceData } from "@/lib/approvals-hub/service";
import { ApprovalsWorkspace, type WorkspaceSection } from "@/components/approvals-hub/approvals-workspace";

export function ExcuseApprovalsBody({ data }: { data: ExcuseWorkspaceData }) {
  const sections: WorkspaceSection[] = [
    { key: "awaiting", title: "Awaiting your response", cards: data.awaiting },
  ];
  return (
    <ApprovalsWorkspace
      sections={sections}
      history={data.history}
      pendingCount={data.pendingCount}
      slaModule="excuse"
      bulkDecisionModule="excuse"
      historyExportTitle="Excuse Approval History"
      historyEmptyLabel="You have not responded to any excuse requests yet."
      myRequests={data.myRequests}
      companyWide={data.companyWide}
      companyWideExportTitle="Company-Wide Excuse Decisions"
      approvalScope={data.approvalScope}
      approvalScopeModuleLabel="excuse"
      companyRequests={data.companyRequests}
      companyRequestsExportTitle="Company Excuse Requests (excl. DM & Medical Rep)"
      companyRequestsEmptyLabel="No excuse requests found (excluding District Managers and Medical Reps)."
    />
  );
}
