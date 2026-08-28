import { redirect } from "next/navigation";

import { ClearanceWorkspace } from "@/components/clearance/clearance-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  clearanceErrorMessage,
  getClearanceDashboardData,
  isClearanceSchemaMissing,
} from "@/lib/clearance/service";
import type { ClearanceDashboardData } from "@/lib/clearance/types";

export const dynamic = "force-dynamic";

function clearancePageError(error: unknown) {
  if (isClearanceSchemaMissing(error)) {
    return "Clearance schema is not ready. Run the Supabase migration for hr_clearance_checklists.";
  }
  return clearanceErrorMessage(error);
}

export default async function ClearancePage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "clearance", "read"))) {
    redirect("/employee-portals");
  }

  // Read and write are separate gates: the CEO reads this page, HR Operations acts on it. The
  // workspace hides every decision control when this is false, and the route handler asserts the
  // same permission again — the page-level check is UX, the route is the security boundary.
  const canDecide = await canAccess(access, "clearance", "update");
  // Opening a checklist for a resignation that predates the auto-open trigger is a CREATE, and the
  // route asserts it as one. Reusing canDecide here would offer a button the API then refuses.
  const canOpen = await canAccess(access, "clearance", "create");

  let initialData: ClearanceDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getClearanceDashboardData(access);
  } catch (error) {
    initialError = clearancePageError(error);
  }

  return (
    <ClearanceWorkspace
      canDecide={canDecide}
      canOpen={canOpen}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
