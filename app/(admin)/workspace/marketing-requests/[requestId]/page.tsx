import { WorkspaceMarketingCaseFilePage } from "@/components/workspace/admin-shell-employee-pages";

/**
 * The Case File in the admin-shell EMPLOYEE WORKSPACE.
 *
 * One of three mounts of the same component. This shell's pages are thin routes that delegate to
 * an exported page function in admin-shell-employee-pages.tsx — the module's own precedent, which
 * is where its access gate and WorkspaceFrame chrome live.
 *
 * No navigation entry is added. Linking it in is a separate step.
 */
export const dynamic = "force-dynamic";

export default async function WorkspaceMarketingRequestCaseFileRoute({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  return <WorkspaceMarketingCaseFilePage requestId={requestId} />;
}
