import { redirect } from "next/navigation";

import {
  ProductionPlanningHeader,
  ProductionPlanningLanguageProvider,
  ProductionPlanningWorkspace,
} from "@/components/production-planning/production-planning-workspace";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReadProductionPlanning } from "@/lib/production-planning/access";
import { resolveProductionPlanningLevel } from "@/lib/production-planning/access-db";

export const dynamic = "force-dynamic";

/**
 * The admin-shell half of the Production Planner: the CEO, the Super Admin and the Finance Manager.
 *
 * 🔴 THE GATE IS NOT `canAccess`. `production_planning` is granted to three roles in the matrix, and
 * the module's main user — Dr. Sahar Khalil, the Toll Manufacturing Manager — holds none of them: her role is
 * `Manager`, which the matrix grants nothing because its other holder is the QPPV. So the gate is
 * `resolveProductionPlanningLevel`, the same named-list-plus-stored-grant answer the API routes use.
 * A matrix check here would refuse her at the door of her own module.
 *
 * A portal-mode viewer is redirected to the portal twin rather than refused, because
 * app/(admin)/layout.tsx would have redirected them to /employee-portals before this file ran and
 * they would never have reached the module at all.
 *
 * The redirect is a REDIRECT, not a rendered page: six pages in this app once returned HTTP 200
 * carrying "Forbidden:" as visible text.
 */
export default async function AdminProductionPlanningPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/production-planning");
  }

  const level = await resolveProductionPlanningLevel(access);
  if (!canReadProductionPlanning(level)) {
    redirect("/overview");
  }

  return (
    <ProductionPlanningLanguageProvider>
      <div className="space-y-6 p-6 sm:p-8">
        <ProductionPlanningHeader />
        <ProductionPlanningWorkspace />
      </div>
    </ProductionPlanningLanguageProvider>
  );
}
