import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { VisualAidsWorkspace } from "@/components/visual-aids/visual-aids-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * Visual Aids in the employee portal — where a rep opens a flyer in front of a doctor, on the
 * tablet, and where the Marketing Manager and the Group Product Manager keep the shelf.
 *
 * The gate is INLINE: `PortalNavEntry.permission` mirrors the permission this page enforces, and the
 * guard that keeps the two honest reads this file. It is UX, not the boundary — every route under
 * /api/visual-aids asserts the permission and then narrows to the viewer's own line.
 */
export default async function EmployeePortalVisualAidsPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/visual-aids");
  }
  if (!(await canAccess(access, "visual_aids", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <EmployeePortalPageShell
      badge="Field Activity"
      description="The flyers and visual aids Marketing has published for your line. Tap one to show it full screen; swipe for the next page."
      title="Visual Aids"
    >
      <VisualAidsWorkspace />
    </EmployeePortalPageShell>
  );
}
