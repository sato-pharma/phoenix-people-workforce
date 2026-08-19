import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestCaseFile } from "@/components/marketing-requests/marketing-request-case-file";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

/**
 * The Case File in the EMPLOYEE PORTAL shell.
 *
 * One of three mounts of the same component, following the MarketingRequestSalesView precedent.
 * This is the mount that matters most to a requester: a REJECTED request disappears from their
 * workspace entirely today, so who refused it and why has never been readable to the person who
 * raised it.
 *
 * No navigation entry is added. Linking it in is a separate step.
 */
export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingRequestCaseFilePage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  await assertEmployeePortalMarketingPageAccess("requests");

  return (
    <EmployeePortalPageShell
      badge="Marketing · Case File"
      description="Everything about one marketing request in one place — the ask, the chain that decided it, where the money is pointed, and what came back. A check that could not run is shown as unknown, never as a clean pass."
      title="Marketing Request Case File"
    >
      <MarketingRequestCaseFile requestId={requestId} />
    </EmployeePortalPageShell>
  );
}
