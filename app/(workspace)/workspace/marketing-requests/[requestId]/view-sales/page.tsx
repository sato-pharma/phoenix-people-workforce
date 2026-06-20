import { WorkspaceMarketingSalesViewPage } from "@/components/workspace/admin-shell-employee-pages";

export const dynamic = "force-dynamic";

export default async function WorkspaceMarketingViewSalesRoute({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  return <WorkspaceMarketingSalesViewPage requestId={requestId} />;
}
