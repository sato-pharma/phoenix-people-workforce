import { redirect } from "next/navigation";

import { DistributorProfileEditor } from "@/components/sales/distributor-profile-editor";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { listEditableProfiles, type EditableProfile } from "@/lib/sales/normalizer/distributor-profile-store";

export const dynamic = "force-dynamic";

export default async function DistributorProfilesPage() {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Mapping-mutation surface — restrict to Super Admin / system, matching the sibling Source-of-Sales
  // admin pages. The write API additionally enforces the sales:import permission.
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  let initialProfiles: EditableProfile[] = [];
  try {
    await assertPermission(accessContext, "sales", "import");
    initialProfiles = await listEditableProfiles();
  } catch {
    // Render the shell; the editor surfaces per-action errors + gating.
  }

  return <DistributorProfileEditor initialProfiles={initialProfiles} />;
}
