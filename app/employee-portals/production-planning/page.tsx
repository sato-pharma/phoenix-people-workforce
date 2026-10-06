import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import {
  ProductionPlanningHeader,
  ProductionPlanningWorkspace,
} from "@/components/production-planning/production-planning-workspace";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReadProductionPlanning } from "@/lib/production-planning/access";
import { resolveProductionPlanningLevel } from "@/lib/production-planning/access-db";
import { PP } from "@/lib/production-planning/strings";

export const dynamic = "force-dynamic";

/**
 * The Production Planner in the employee portal, which is where its MAIN USER opens it.
 *
 * Dr. Sahar Khalil holds `Manager` and Reham Elwiy holds `Employee`. Both are portal-shell roles,
 * so app/(admin)/layout.tsx would redirect either of them out of the admin twin before it ran —
 * this page is not a secondary surface, it is the primary one.
 *
 * 🔴 THE GATE IS NOT `canAccess`, for the same reason as the admin twin: neither of them holds
 * `production_planning` in the matrix, and granting it to their roles would open every raw-material
 * price to the QPPV and to the whole company. `resolveProductionPlanningLevel` is the named list
 * plus the stored grants, which is also what every /api/production-planning route asks.
 *
 * The module brings its OWN header as the shell's `hero`, which replaces the portal's Latin
 * badge/title banner. Passing the Arabic title to the shell instead would stack a left-aligned
 * header above a right-to-left one.
 */
export default async function EmployeePortalProductionPlanningPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/production-planning");
  }

  const level = await resolveProductionPlanningLevel(access);
  if (!canReadProductionPlanning(level)) {
    redirect("/employee-portals");
  }

  return (
    <EmployeePortalPageShell
      errorBoundaryTitle={PP.moduleTitle}
      hero={<ProductionPlanningHeader />}
      title={PP.moduleTitle}
    >
      <ProductionPlanningWorkspace />
    </EmployeePortalPageShell>
  );
}
