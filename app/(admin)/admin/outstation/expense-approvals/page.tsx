import { redirect } from "next/navigation";

import { DeskWorkspace } from "@/components/outstation/approvals-desk/desk-workspace";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canReviewOutstationExpenseApprovals } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/** The address's own query, as one string — the desk keeps its lane, search and open trip there. */
function searchText(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") query.set(key, first);
  }
  return query.toString();
}

/**
 * Expense Approvals — the decision desk (rebuilt 2026-11-23; owner: "REBUILD FROM SCRATCH").
 *
 * The page only checks who may open it and hands the address's query down, so a reload or a shared
 * link opens the same lane, search and trip. Whether the caller may DECIDE is not passed from here:
 * the queue's own answer says so (`canDecide`), and the decide route asserts the Super Admin
 * workspace and a real session on its own — hiding a button is never the gate.
 */
export default async function OutstationExpenseApprovalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const access = await resolveAccessContextFromPage();
  // Widened from Super-Admin-only on 2026-08-08 so the CEO can read the claim validation.
  if (!canReviewOutstationExpenseApprovals(access)) {
    redirect("/admin/access");
  }

  return (
    <CrmSurfaceProvider surface="admin">
      <DeskWorkspace initialSearch={searchText(await searchParams)} />
    </CrmSurfaceProvider>
  );
}
