import { WorkspaceMarketingDecisionPage } from "@/components/workspace/admin-shell-employee-pages";

export const dynamic = "force-dynamic";

export default async function WorkspaceMarketingDecisionRoute({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { requestId } = await params;
  return <WorkspaceMarketingDecisionPage requestId={requestId} searchParams={await searchParams} />;
}
