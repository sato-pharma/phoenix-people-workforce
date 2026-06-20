import { redirect } from "next/navigation";

import { WeeklyDistributorColumnEditor } from "@/components/sales/weekly/weekly-distributor-column-editor";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listEditableWeeklyContracts, type EditableWeeklyContract } from "@/lib/sales/weekly/weekly-column-profile-store";

export const dynamic = "force-dynamic";

export default async function WeeklyDistributorEditorPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  // Mapping-mutation surface that changes how files are imported — restrict to Super Admin / system,
  // matching the monthly distributor editor. The write API additionally enforces weekly_sales:import.
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  let initialContracts: EditableWeeklyContract[] = [];
  try {
    await assertPermission(accessContext, "weekly_sales", "import");
    initialContracts = await listEditableWeeklyContracts();
  } catch {
    // Render the shell; the editor surfaces per-action errors + gating.
  }

  return <WeeklyDistributorColumnEditor initialContracts={initialContracts} />;
}
