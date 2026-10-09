import { WorkspaceDeductionsPage } from "@/components/workspace/admin-shell-employee-pages";

export const dynamic = "force-dynamic";

// No searchParams: the month, type and status filters moved inside the workspace on 2026-10-09, so
// the page reads every month from the September salary onwards and narrows in the browser.
export default async function WorkspaceDeductionsRoute() {
  return <WorkspaceDeductionsPage />;
}
